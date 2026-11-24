// A routine's probe check (Routine.probe): plain code reads one public page (or part of it), feed, price or script output
// before any AI turn. A posting script (`post`) is not compared: what it prints is each run's reply. Otherwise the same
// reading as last time is nothing new and wakes no model; a change becomes one run, and the reading is kept only once
// that run's answer is, so a run that fails sees the change again. A read that fails is a failed check, never "nothing
// new", and says so once per streak. State is a hash or a price and a few item ids per routine (routine-probes.json).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RoutineProbe } from "../shared/routines.ts";
import { writeFileAtomic } from "./atomic.ts";
import { clean, recordsBlock, recordsText } from "./records-block.ts";
import type { Routine, RoutineCheckResult, RoutineChecks, RoutineRun } from "./routines.ts";
import { SCRIPT_OUTPUT_MAX, wakeAsked, type ScriptResult } from "./routine-script.ts";
import { fetchPublicPage, pageText, type PublicPage } from "./wait-probes.ts";

export const PROBES_FILE = "routine-probes.json";
const KEY_PREFIX = "prb-";
const EXCERPT = 6_000;
const FEED_ITEMS = 30;
const PENDING_MS = 3 * 60 * 60_000;
const LAST_KEPT = 2_000;
/** Failed reads in a row before the person hears of it, once per streak; from then on reads back off. */
export const STUCK_AFTER = 3;
const RETRY_FIRST_MS = 15 * 60_000;
const RETRY_MAX_MS = 4 * 60 * 60_000;
export const NO_SCRIPTS = "Script checks run only on the person's own computer, not here.";

/** What one read found: `value` is what is compared (a hash, a price), `items` a feed's newest item ids. */
export interface ProbeReading {
  value: string;
  items?: Array<{ id: string; title: string; link?: string }>;
  text?: string;
  price?: string;
  /** A script asked to be woken whatever changed. */
  wake?: true;
}

interface Kept {
  /** The probe's address, with its selector or script hash: another one starts over. */
  url: string;
  kind: RoutineProbe["kind"];
  value: string;
  seen?: string[];
  price?: string;
  at: number;
  failing?: true;
  /** Failed reads in a row, and no read before `retryAt` once they reach STUCK_AFTER. */
  fails?: number;
  retryAt?: number;
  trouble?: string;
  /** A script's last output, so a change can be shown beside it. */
  last?: string;
  pending?: Record<string, { at: number; value: string; seen?: string[]; price?: string; last?: string }>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };
const unescape = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => ENTITY[name]!).trim();
const tag = (block: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return match ? unescape(match[1]!) : undefined;
};

/** A feed's newest items, RSS or Atom: each by its guid, id or link. */
export function feedItems(xml: string): NonNullable<ProbeReading["items"]> {
  const items: NonNullable<ProbeReading["items"]> = [];
  for (const match of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const block = match[2]!;
    const href = /<link[^>]*\bhref=["']([^"']+)["']/i.exec(block)?.[1];
    const link = tag(block, "link") || href;
    const id = tag(block, "guid") || tag(block, "id") || link || tag(block, "title");
    if (id) items.push({ id: id.slice(0, 500), title: (tag(block, "title") ?? "").slice(0, 300), ...(link ? { link: link.slice(0, 1_000) } : {}) });
    if (items.length >= FEED_ITEMS) break;
  }
  return items;
}

/** The page's price: its structured data first (JSON-LD, microdata, Open Graph), else the first amount with a currency
 * sign in its words. Null when there is none. */
export function pagePrice(html: string, text: string): string | null {
  const structured = /"price"\s*:\s*"?(\d[\d,]*(?:\.\d+)?)"?/.exec(html)?.[1] ??
    /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i.exec(html)?.[1] ??
    /property=["'](?:product|og):price:amount["'][^>]*content=["']([\d.,]+)["']/i.exec(html)?.[1];
  const currency = /"priceCurrency"\s*:\s*"([A-Z]{3})"/.exec(html)?.[1];
  if (structured) return currency ? `${structured} ${currency}` : structured;
  const shown = /([$€£₹¥])\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(text);
  return shown ? `${shown[1]}${shown[2]}` : null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The inside of the first element `selector` (#id, .class, tag, tag#id, tag.class) names; null when none does. */
export function sectionOf(html: string, selector: string): string | null {
  const parts = /^([a-z][a-z0-9-]*)?(?:([#.])([\w-]+))?$/i.exec(selector);
  if (!parts || (!parts[1] && !parts[3])) return null;
  const [, tag, sign, name] = parts;
  const id = new RegExp(`\\bid\\s*=\\s*(["']?)${escapeRe(name ?? "")}\\1(?=[\\s/>]|$)`, "i");
  const classes = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  for (const open of html.matchAll(new RegExp(`<(${tag ? escapeRe(tag) : "[a-z][a-z0-9-]*"})\\b([^>]*)>`, "gi"))) {
    const attrs = open[2] ?? "";
    if (sign === "#" && !id.test(attrs)) continue;
    if (sign === ".") {
      const list = classes.exec(attrs);
      if (!list || !(list[1] ?? list[2] ?? list[3] ?? "").split(/\s+/).includes(name!)) continue;
    }
    const element = open[1]!.toLowerCase();
    const start = open.index! + open[0].length;
    if (VOID.has(element) || open[0].endsWith("/>")) return "";
    const walker = new RegExp(`<(/?)${escapeRe(element)}\\b[^>]*>`, "gi");
    walker.lastIndex = start;
    let depth = 1;
    for (let step = walker.exec(html); step; step = walker.exec(html)) {
      if (step[0].endsWith("/>")) continue;
      depth += step[1] ? -1 : 1;
      if (depth === 0) return html.slice(start, step.index);
    }
    return html.slice(start);
  }
  return null;
}

/** What a script printed, as a reading: a {"wakeAgent": false} line is nothing new, so it never reaches here. */
export function scriptReading(output: string): ProbeReading {
  const text = output.trim();
  return { value: sha(text), text, ...(wakeAsked(text) === true ? { wake: true as const } : {}) };
}

/** What a posting script's output says to the person: its words without a last {"wakeAgent": true} line; empty is quiet. */
export function scriptPost(output: string): string {
  const text = output.trim().slice(0, SCRIPT_OUTPUT_MAX);
  return wakeAsked(text) === true ? text.split(/\r?\n/).slice(0, -1).join("\n").trim() : text;
}

/** Where a probe reads from, as kept: a page with its selector, or a script by its command's hash. */
export const probeSource = (probe: RoutineProbe) =>
  probe.kind === "script" ? `script:${sha(probe.command ?? "")}` : probe.selector ? `${probe.url} ${probe.selector}` : probe.url;

export function readingOf(probe: RoutineProbe, page: Extract<PublicPage, { ok: true }>): ProbeReading | { error: string } {
  const whole = page.body.toString("utf8");
  const body = probe.selector ? sectionOf(whole, probe.selector) : whole;
  if (body === null) return { error: `Nothing on the page matches ${probe.selector}.` };
  if (probe.kind === "feed") {
    const items = feedItems(body);
    return items.length ? { value: sha(items.map((item) => item.id).join("\n")), items } : { error: "It has no feed items to read." };
  }
  const text = pageText(body);
  if (probe.kind === "price") {
    const price = pagePrice(body, text);
    return price ? { value: price, price } : { error: "No price could be found on it." };
  }
  return text ? { value: sha(text), text } : { error: "The page has no words to compare." };
}

export interface RoutineProbesDeps {
  dataDir: string;
  now?: () => number;
  fetch?: (url: string) => Promise<PublicPage>;
  /** Runs a script check's command; absent, script checks fail with NO_SCRIPTS. */
  script?: (routine: Routine, command: string) => Promise<ScriptResult>;
  /** Once per streak, at its STUCK_AFTER-th failed read: the person hears it, so a probe that cannot read never looks
   * quiet for long. */
  failed?(routine: Routine, sentence: string, count: number): void;
}

export function createRoutineProbes(deps: RoutineProbesDeps) {
  const file = join(deps.dataDir, PROBES_FILE);
  const now = deps.now ?? Date.now;
  const fetchPage = deps.fetch ?? ((url: string) => fetchPublicPage(url));
  let state: Record<string, Kept> = {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) state = value as Record<string, Kept>;
  } catch { /* none yet */ }

  const save = () => {
    try { writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 }); }
    catch (error) { console.warn(`probes: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const ownerOf = (key: string): Kept | undefined => Object.values(state).find((kept) => kept.pending?.[key]);
  const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
  const where = (probe: RoutineProbe) => probe.kind === "script" ? "its script" : host(probe.url);

  async function read(routine: Routine, probe: RoutineProbe): Promise<ProbeReading | { error: string } | { asleep: true }> {
    if (probe.kind === "script") {
      if (!deps.script) return { error: NO_SCRIPTS };
      const result = await deps.script(routine, probe.command ?? "");
      if (!result.ok) return { error: result.error };
      return wakeAsked(result.output) === false ? { asleep: true } : scriptReading(result.output);
    }
    const page = await fetchPage(probe.url);
    return page.ok ? readingOf(probe, page) : { error: page.error };
  }

  function prompt(routine: Routine, probe: RoutineProbe, kept: Kept, reading: ProbeReading, newItems: NonNullable<ProbeReading["items"]>): string {
    const source = probe.kind === "script" ? "the routine's own script check" : `${host(probe.url)}, a public web page`;
    const lines = [routine.prompt.trim(), ""];
    if (probe.kind === "script") {
      lines.push(reading.wake ? "The routine's script check asked for this run. What it printed:" : "The routine's script check printed something new. What it printed now:",
        recordsText(source, reading.text!.slice(0, EXCERPT)));
      if (kept.last && !reading.wake) lines.push("What it printed at the last check:", recordsText(source, kept.last));
    } else if (probe.kind === "price") {
      lines.push(`The routine's price check found that the price at ${probe.url} changed from ${clean(kept.price ?? kept.value, 60)} to ${clean(reading.price!, 60)}.`);
    } else if (probe.kind === "feed") {
      lines.push(`The routine's feed check found ${newItems.length} new item${newItems.length === 1 ? "" : "s"} in ${probe.url}:`,
        recordsBlock(source, newItems.map((item) => `${item.title || "(untitled)"}${item.link ? ` · ${item.link}` : ""}`)));
    } else {
      const part = probe.selector ? ` (the part ${probe.selector})` : "";
      lines.push(`The routine's page check found that ${probe.url}${part} changed since the last check. What it says now:`, recordsText(source, reading.text!.slice(0, EXCERPT)));
    }
    lines.push("If the change does not matter for these instructions, answer with one short line saying so.");
    return lines.join("\n");
  }

  const checks: RoutineChecks = {
    async check(routine, context): Promise<RoutineCheckResult> {
      const probe = routine.probe;
      if (!probe) return {};
      if (context.hold) return { held: true };
      let kept: Kept | undefined = state[routine.id];
      const from = probeSource(probe);
      if (kept && (kept.url !== from || kept.kind !== probe.kind)) kept = undefined;
      for (const [key, pending] of Object.entries(kept?.pending ?? {})) if (now() - pending.at > PENDING_MS) delete kept!.pending![key];
      // a run already holds a change: it is that run's to answer
      if (kept?.pending && Object.keys(kept.pending).length) return { held: true };
      if (!context.manual && kept?.retryAt !== undefined && now() < kept.retryAt) return { held: true, ...(kept.trouble ? { trouble: kept.trouble } : {}) };
      const reading = await read(routine, probe);
      if ("error" in reading) {
        const sentence = `Couldn't check ${where(probe)}: ${reading.error}`;
        kept ??= state[routine.id] = { url: from, kind: probe.kind, value: "", at: now() };
        const fails = (kept.fails ?? 0) + 1;
        Object.assign(kept, { fails, failing: true as const, trouble: sentence }, fails >= STUCK_AFTER ? { retryAt: now() + Math.min(RETRY_FIRST_MS * 2 ** (fails - STUCK_AFTER), RETRY_MAX_MS) } : {});
        save();
        if (fails === STUCK_AFTER) deps.failed?.(routine, sentence, fails);
        return { trouble: sentence };
      }
      if (kept) for (const field of ["failing", "fails", "retryAt", "trouble"] as const) delete kept[field];
      if ("asleep" in reading) {
        if (kept) { kept.at = now(); save(); }
        return {};
      }
      if (probe.kind === "script" && probe.post) {
        const post = scriptPost(reading.text!);
        kept ??= state[routine.id] = { url: from, kind: probe.kind, value: "", at: now() };
        if (!post) { kept.at = now(); save(); return {}; }
        const key = `${KEY_PREFIX}${randomUUID()}`;
        kept.pending = { [key]: { at: now(), value: reading.value } };
        save();
        return { run: { key, prompt: routine.prompt, post } };
      }
      const last = probe.kind === "script" ? reading.text!.slice(0, LAST_KEPT) : undefined;
      const seen = reading.items?.map((item) => item.id);
      // the first good read is the baseline: nothing to compare yet
      if ((!kept || !kept.value) && !reading.wake) {
        state[routine.id] = { url: from, kind: probe.kind, value: reading.value, at: now(), ...(seen ? { seen } : {}), ...(reading.price ? { price: reading.price } : {}), ...(last ? { last } : {}) };
        save();
        return {};
      }
      kept ??= state[routine.id] = { url: from, kind: probe.kind, value: "", at: now() };
      const fresh = reading.items?.filter((item) => !kept!.seen?.includes(item.id)) ?? [];
      const changed = reading.wake || (probe.kind === "feed" ? fresh.length > 0 : reading.value !== kept.value);
      if (!changed) {
        kept.at = now();
        if (seen) kept.seen = seen;
        save();
        return {};
      }
      const key = `${KEY_PREFIX}${randomUUID()}`;
      kept.pending = { [key]: { at: now(), value: reading.value, ...(seen ? { seen } : {}), ...(reading.price ? { price: reading.price } : {}), ...(last ? { last } : {}) } };
      save();
      return { run: { key, prompt: prompt(routine, probe, kept, reading, fresh) } };
    },
    release(key) {
      const kept = ownerOf(key);
      if (!kept) return;
      delete kept.pending![key];
      save();
    },
    settled(run: RoutineRun) {
      const key = run.checkKey;
      const kept = key ? ownerOf(key) : undefined;
      if (!key || !kept) return;
      const pending = kept.pending![key]!;
      if (run.status === "completed") Object.assign(kept, { value: pending.value, at: now() }, pending.seen ? { seen: pending.seen } : {}, pending.price ? { price: pending.price } : {}, pending.last ? { last: pending.last } : {});
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "missed") {
        delete kept.pending![key];
        save();
      }
    },
  };
  return checks;
}

/** One set of checks for the routine manager: a routine with a probe goes to the probe, every other to `inner`. */
export function withProbes(inner: RoutineChecks | undefined, probes: RoutineChecks): RoutineChecks {
  return {
    check: (routine, context) => routine.checks?.includes("probe") ? probes.check(routine, context) : inner?.check(routine, context) ?? Promise.resolve({}),
    release: (key) => (key.startsWith(KEY_PREFIX) ? probes.release(key) : inner?.release(key)),
    settled: (run) => (run.checkKey?.startsWith(KEY_PREFIX) ? probes.settled(run) : inner?.settled(run)),
  };
}
