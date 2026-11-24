// The server's side of quiet routines and the weekly allowance, wired once from index.ts: the allowance and its holds,
// probe checks beside the proactive ones, each routine's 3x self-cap, the waking hours new routines are shaped to, and
// how early a Cloud home may run an "around this time" routine.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createAllowance } from "../allowance.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ledgerCost } from "../model-prices.ts";
import { createRoutineProbes, withProbes } from "../routine-probe.ts";
import { runCheckScript, scriptRunOptions } from "../routine-script.ts";
import { flexOf, useFreeReruns } from "../routine-quiet.ts";
import { nextOccurrence } from "../routine-schedules.ts";
import { createRoutineSelfCap } from "../routine-self-cap.ts";
import { shapeNewRoutine, useWakingWindow } from "../routine-shape.ts";
import type { Routine, RoutineChecks, RoutineManager, RoutineRun } from "../routines.ts";
import { serverLine } from "../server-lines.ts";
import type { Spend } from "../spend.ts";
import { fetchPublicPage } from "../wait-probes.ts";
import { createWakingHours } from "../waking-hours.ts";
import { outsideQuiet, type QuietHours } from "./proactive-prefs.ts";

const FREE_FILE = "free-reruns.json";
const SKIPPED_FILE = "limit-skips.json";
const FREE_KEPT = 200;

function loadIds(file: string): string[] {
  try { const value = JSON.parse(readFileSync(file, "utf8")) as { runs?: unknown }; return Array.isArray(value.runs) ? value.runs.filter((id): id is string => typeof id === "string").slice(-FREE_KEPT) : []; }
  catch { return []; }
}
function saveIds(file: string, runs: string[]): void {
  try { writeFileAtomic(file, JSON.stringify({ runs }), { mode: 0o600 }); }
  catch (error) { console.warn(`routines: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

export interface RoutineHostDeps {
  dataDir: string;
  cloudHome: boolean;
  spend: Spend;
  routines(): RoutineManager | null;
  botName(id: string): string | undefined;
  /** The bot's model and engine kind, for a running turn's price. */
  model(botId: string): { driverKind: string; model: string } | undefined;
  tell(botId: string, threadId: string | undefined, text: string): void;
  language(threadId: string | undefined): string | undefined;
  /** Only a verification fixture sets this (control-dusk): one loopback origin its probes may read. */
  probeLoopbackOrigin?: string;
}

/** Enabled routines with a run before `until`, each once with its next time. */
export function upcomingRuns(routines: readonly Routine[], now: number, until: number): Array<{ routineId: string; name: string; at: number }> {
  return routines.flatMap((routine) => {
    if (!routine.enabled || routine.nextRunAt == null) return [];
    const at = routine.nextRunAt >= now ? routine.nextRunAt : nextOccurrence(routine.schedule, now);
    return at !== null && at < until ? [{ routineId: routine.id, name: routine.name, at }] : [];
  }).sort((a, b) => a.at - b.at);
}

export function createRoutineHost(deps: RoutineHostDeps) {
  const list = () => deps.routines()?.listRoutines() ?? [];
  const resultsThread = (routine: Pick<Routine, "resultsThreadId" | "sourceThreadId">) => routine.resultsThreadId ?? routine.sourceThreadId;
  const loopback = deps.probeLoopbackOrigin && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(deps.probeLoopbackOrigin) ? deps.probeLoopbackOrigin : undefined;

  // the runs started again, free, after an update was rolled back: by their new run ids, so the strip and the
  // allowance know them across a restart
  let free = loadIds(join(deps.dataDir, FREE_FILE));
  const isFree = (runId: string) => free.includes(runId);
  // the runs the weekly limit held back: never a card or an alert, only "skipped: weekly limit" on the routine's strip
  let skipped = loadIds(join(deps.dataDir, SKIPPED_FILE));
  const isSkipped = (runId: string) => skipped.includes(runId);
  useFreeReruns(isFree, isSkipped);

  const allowance = createAllowance({
    dataDir: deps.dataDir,
    since: (at) => deps.spend.since(at),
    free: isFree,
    names: {
      bot: deps.botName,
      routine: (id) => { const routine = list().find((one) => one.id === id); return routine ? { name: routine.name, botId: routine.botId } : undefined; },
    },
    upcoming: (until) => upcomingRuns(list(), Date.now(), until),
  });

  const probes = createRoutineProbes({
    dataDir: deps.dataDir,
    fetch: (url) => fetchPublicPage(url, loopback && url.startsWith(`${loopback}/`) ? { allow: () => true } : {}),
    // Security: a Cloud home runs no script checks; its routines can be written by people who do not own the machine.
    ...(deps.cloudHome ? {} : { script: (routine: Routine, command: string) => runCheckScript(command, scriptRunOptions(routine)) }),
    failed: (routine, sentence, count) => {
      const thread = resultsThread(routine);
      deps.tell(routine.botId, thread, serverLine(deps.language(thread), "server.routine.probeStuck", { routine: routine.name, count, reason: sentence }));
    },
  });

  const selfCap = createRoutineSelfCap({
    run: (threadId) => deps.routines()?.runForThread(threadId) ?? null,
    usual: (routineId) => deps.spend.usualRunUsd(routineId),
    estimate: (threadId, usage) => {
      const run = deps.routines()?.runForThread(threadId);
      const model = run ? deps.model(run.botId) : undefined;
      return model ? ledgerCost({ ...model, input: usage.input, output: usage.output, ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}), costUsd: null }, null).costUsd : null;
    },
    stop: (run: RoutineRun, reason) => {
      void deps.routines()?.cancelRun(run.id, reason);
      const thread = run.resultsThreadId ?? run.sourceThreadId, language = deps.language(thread);
      deps.tell(run.botId, thread, serverLine(language, "server.routine.selfCap", { routine: run.routineName }));
    },
  });

  const wakingHours = createWakingHours({ dataDir: deps.dataDir });
  let quietHours: () => QuietHours | null = () => null;
  useWakingWindow(() => outsideQuiet(wakingHours.window(), quietHours()));

  return {
    allowance,
    selfCap,
    wakingHours,
    checks: (inner: RoutineChecks | undefined): RoutineChecks => withProbes(inner, probes),
    /** Only a Cloud home runs an "around this time" routine early: it may fold it into a wake it has anyway. */
    earlyMs: deps.cloudHome ? (routine: Routine) => flexOf(routine) : undefined,
    shape: <T>(input: T): T => shapeNewRoutine(input as never) as T,
    /** The person's quiet hours, which the waking hours new routines are shaped to leave out. */
    useQuietHours(read: () => QuietHours | null): void { quietHours = read; },
    /** Runs a rolled-back version failed (server/update-state.ts `takeFreeReruns()`): each of their routines runs
     * again once, never held by or charged to the allowance, and its strip says so. A run already re-run, or whose
     * routine is gone, is skipped. Returns the new runs' ids. */
    rerunFree(failedRunIds: readonly string[]): string[] {
      const manager = deps.routines();
      if (!manager || !failedRunIds.length) return [];
      const runs = manager.listRuns();
      const started: string[] = [];
      for (const routineId of new Set(failedRunIds.flatMap((id) => runs.filter((run) => run.id === id && !run.dryRun).map((run) => run.routineId)))) {
        const run = manager.runNow(routineId);
        if (run) started.push(run.id);
      }
      if (started.length) {
        free = [...free, ...started].slice(-FREE_KEPT);
        saveIds(join(deps.dataDir, FREE_FILE), free);
      }
      return started;
    },
    /** Why a run may not start for the allowance, or null: a free re-run always may. */
    allowanceHeld(run: Pick<RoutineRun, "id">, language: string | undefined): string | null {
      const held = isFree(run.id) ? null : allowance.held(language);
      if (held && !isSkipped(run.id)) { skipped = [...skipped, run.id].slice(-FREE_KEPT); saveIds(join(deps.dataDir, SKIPPED_FILE), skipped); }
      return held;
    },
    /** A run the weekly limit skipped: it posts no card, raises no alert and counts as seen. */
    limitSkipped: isSkipped,
    /** A person's new task waits while the allowance is used up and Saver mode is off. */
    assertMayStart(threadId: string, continuing: boolean): void {
      if (continuing) return;
      const waiting = allowance.refusal(deps.language(threadId));
      if (waiting) throw Object.assign(new Error(waiting), { status: 409, code: "allowance" });
    },
  };
}
