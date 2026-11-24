// Quiet, honest routines: what a probe check may read, when a routine may move ("around this time"), and the strip of
// its last seven outcomes, which tells "didn't fire" from "fired, nothing new". Pure over a routine and its runs.
import { ROUTINE_AROUND_MS, runStrip, STRIP_RUNS, type RoutineCheck, type RoutineCheckTick, type RoutineProbe, type RoutineStripEntry, type RoutineTiming } from "../shared/routines.ts";
export { SELF_CAP_STOP } from "../shared/routines.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { RoutineSchedule } from "./routine-schedules.ts";

const MAX_URL = 2_000;

let freeRerun: (runId: string) => boolean = () => false;
let limitSkip: (runId: string) => boolean = () => false;
/** The runs re-run free after an update was rolled back, and those the weekly limit skipped
 * (server/host/routine-quiet-host.ts): each marked on the strip. */
export function useFreeReruns(isFree: (runId: string) => boolean, isSkipped: (runId: string) => boolean = () => false): void { freeRerun = isFree; limitSkip = isSkipped; }

const MAX_COMMAND = 2_000;
const SELECTOR = /^[a-z][a-z0-9-]*$|^[a-z][a-z0-9-]*[#.][\w-]+$|^[#.][\w-]+$/i;

/** A probe as asked for: undefined for none, an error for one that cannot be read. */
export function cleanProbe(value: unknown): RoutineProbe | undefined {
  if (value == null) return undefined;
  const { kind, url, selector, command, post, access } = value as Partial<RoutineProbe>;
  if (kind !== "script" && (post !== undefined || access !== undefined)) throw new Error("A page, feed or price check cannot post what it reads or run with full access; only a script check can");
  if (kind === "script") {
    const line = typeof command === "string" ? command.trim() : "";
    if (!line || line.length > MAX_COMMAND || /[\0\r\n]/.test(line)) throw new Error("Give the script check one command line of at most 2,000 characters");
    if (post !== undefined && post !== true) throw new Error("A script check's post can only be true");
    if (access !== undefined && access !== "full") throw new Error("A script check's access can only be full");
    return { kind, url: "", command: line, ...(post ? { post } : {}), ...(access ? { access } : {}) };
  }
  if (kind !== "page" && kind !== "feed" && kind !== "price") throw new Error("Choose a page, a feed, a price or a script to check");
  const text = typeof url === "string" ? url.trim() : "";
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error("Give the page's full web address, starting with https://"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || text.length > MAX_URL) {
    throw new Error("Only an http or https address with no sign-in details can be checked");
  }
  const part = typeof selector === "string" ? selector.trim() : "";
  if (part && (kind !== "page" || !SELECTOR.test(part) || part.length > 200)) throw new Error("A selector applies only to a page check, as #id, .class, tag, tag#id or tag.class");
  return { kind, url: parsed.toString(), ...(part ? { selector: part } : {}) };
}

/** A probe as kept on disk; anything out of range is dropped. */
export function loadProbe(value: unknown): RoutineProbe | undefined {
  try { return cleanProbe(value); } catch { return undefined; }
}

/** Only a run at a time of day may move: a daily, weekly, one-off or cron run. */
export const mayMove = (schedule: RoutineSchedule): boolean => schedule.type === "daily" || schedule.type === "cron" || schedule.type === "once";

export function cleanTiming(value: unknown, schedule: RoutineSchedule, checks: readonly RoutineCheck[] | undefined): RoutineTiming | undefined {
  if (value == null) return undefined;
  if (value !== "around") throw new Error("Choose an exact time or around this time");
  return mayMove(schedule) && !checks?.length ? "around" : undefined;
}

/** How far this routine's run may move either way; 0 for its exact time. */
export const flexOf = (routine: Pick<Routine, "timing" | "schedule" | "checks">): number =>
  routine.timing === "around" && mayMove(routine.schedule) && !routine.checks?.length ? ROUTINE_AROUND_MS : 0;

/** The probe and timing a patch leaves: its own, or the routine's when it names none. */
export function quietPatch(patch: { probe?: RoutineProbe | null; timing?: RoutineTiming | null }, routine: Pick<Routine, "probe" | "timing">) {
  return {
    probe: Object.hasOwn(patch, "probe") ? patch.probe : routine.probe,
    timing: Object.hasOwn(patch, "timing") ? patch.timing : routine.timing,
  };
}

/** Drops the quiet fields an update cleared, and the probe's ticks once it has no checks. */
export function dropQuietFields(routine: Routine, clean: Pick<Routine, "probe" | "timing" | "checks">): void {
  if (!clean.probe) delete routine.probe;
  if (!clean.timing) delete routine.timing;
  if (!clean.checks) delete routine.ticks;
}

/** A check that started no run leaves a tick: "quiet" when it read everything and found nothing, "failed" when it could
 * not read. One that started a run leaves none: that run is the strip's entry. */
export function nextTicks(routine: Pick<Routine, "ticks">, result: { run?: unknown; trouble?: string; held?: true }, at: number): RoutineCheckTick[] | undefined {
  if (result.run || result.held) return routine.ticks;
  return [...(routine.ticks ?? []), { at, outcome: result.trouble ? "failed" as const : "quiet" as const }].slice(-STRIP_RUNS);
}

export function loadTicks(value: unknown): RoutineCheckTick[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ticks = value.filter((tick): tick is RoutineCheckTick => Boolean(tick) && Number.isSafeInteger(tick.at) && tick.at >= 0 &&
    (tick.outcome === "quiet" || tick.outcome === "failed")).map(({ at, outcome }) => ({ at, outcome })).slice(-STRIP_RUNS);
  return ticks.length ? ticks : undefined;
}

/** The last seven outcomes, oldest first: finished runs (not tests) and the checks' ticks. */
export function stripOf(runs: readonly RoutineRun[], routine: Pick<Routine, "id" | "ticks">): RoutineStripEntry[] {
  return runStrip(runs, routine, freeRerun, limitSkip);
}
