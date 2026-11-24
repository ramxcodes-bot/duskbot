/** Routine wire shapes: the routine and run records as they ride the REST
 * snapshot and the `routine` / `routine.run` live frames. */
import type { LimitResetSchedule, LimitResetScheduleInput } from "./limit-reset.ts";
import type { RoutineCronSchedule } from "./routine-schedule.ts";

export interface RoutineIntervalWindow {
  start: string;
  end: string;
}

export type RoutineSchedule =
  | RoutineCronSchedule
  | LimitResetSchedule
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt: number;
    /** Local weekdays (Sunday = 0). Missing means every day. */
    weekdays?: number[];
    /** Local wall-clock window. Missing means all day. */
    window?: RoutineIntervalWindow;
    /** Inclusive epoch-millisecond cutoff. Missing means never. */
    endsAt?: number;
  };

export type RoutineScheduleInput =
  | Extract<RoutineSchedule, { type: "once" | "daily" | "cron" }>
  | LimitResetScheduleInput
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt: number;
    /** `null` explicitly restores the every-day default on updates. */
    weekdays?: number[] | null;
    /** `null` explicitly restores the all-day default on updates. */
    window?: RoutineIntervalWindow | null;
    /** `null` explicitly removes an existing end date on updates. */
    endsAt?: number | null;
  };

export type RoutineRunOn = "maus" | "cloud";

export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus =
  | "completed"
  | "needs-input"
  | "blocked"
  | "limit-reached"
  | "paused"
  | "stopped"
  | "failed";

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

/** "api": an outside caller through the bot's API; "webhook": an outside event. Both run as nobody's work. */
export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "startup" | "api";

/** A check a routine runs on each tick before any AI turn, in plain code: `calendar` reads the next 36 hours, `mail`
 * new inbox mail since the last check, `runs` other routines' finished runs, `probe` one public page, feed or price, or
 * a script's output (`Routine.probe`). Nothing new means no AI turn. */
export type RoutineCheck = "calendar" | "mail" | "runs" | "probe";
export const ROUTINE_CHECKS: readonly RoutineCheck[] = ["calendar", "mail", "runs", "probe"];

/** What a `probe` check reads: a page's words (or only the part `selector` names), a feed's newest items, the first
 * price on a page, or what `command` prints on the computer the routine runs on. A script's output is compared with
 * the last; a script that prints {"wakeAgent": false} keeps the run asleep and {"wakeAgent": true} always wakes it.
 * With `post`, a script's output is the run's report as written and no AI turn runs (see `post`). */
export interface RoutineProbe {
  kind: "page" | "feed" | "price" | "script";
  /** Empty for a script. */
  url: string;
  /** page only: `#id`, `.class`, `tag`, `tag#id` or `tag.class`; the first element it names. */
  selector?: string;
  /** script only: one shell command line, run without the bot's AI. */
  command?: string;
  /** script only: what it prints becomes the bot's reply as written, every time, with no AI turn. Empty output or a last
   * line of {"wakeAgent": false} is a quiet run; a failed or timed-out script is a failed run. */
  post?: true;
  /** script only: `full` runs it outside the read-only fence, as the server's user. Set only through the person's card.
   * Missing means the fence. */
  access?: "full";
}

/** `around`: the run may move up to ROUTINE_AROUND_MS either way, so a Cloud home can fold it into a wake it has
 * anyway. Missing means its exact time. */
export type RoutineTiming = "around";
export const ROUTINE_AROUND_MS = 30 * 60_000;

/** One of a routine's last runs as its strip shows them: `ok` did something, `quiet` fired and found nothing new,
 * `failed` went wrong, `missed` never fired. Oldest first. */
export interface RoutineStripEntry {
  at: number;
  /** `skipped`: held back by the account's weekly limit, which is no failure. */
  outcome: "ok" | "quiet" | "failed" | "missed" | "skipped";
  /** Re-ran once, free, after an update was rolled back. */
  rerun?: true;
}

export interface RoutineCheckTick { at: number; outcome: "quiet" | "failed" }

/** The fields a routine carries for quiet checks and flexible timing. */
export interface RoutineQuietFields {
  probe?: RoutineProbe;
  timing?: RoutineTiming;
  /** Its checks' last ticks that started no run, newest last, at most seven: nothing new, or a read that failed. */
  ticks?: RoutineCheckTick[];
  /** Its last seven outcomes, built for the client. */
  strip?: RoutineStripEntry[];
}

/** The same, as a create or update asks for them: `null` removes one on updates; omission preserves it. */
export interface RoutineQuietInput {
  probe?: RoutineProbe | null;
  timing?: RoutineTiming | null;
}

/** What a routine's runs may do. `read-and-draft`: read Gmail and Google Calendar and write reply drafts; every other
 * tool is refused outright, never turned into a card. Missing means the bot's own level. */
export type RoutineAccess = "read-and-draft";

/** Where a routine's results go. `brief`: they become rows of the main agent's brief, not chat lines of their own. */
export type RoutineDelivery = "brief";

/** Why dusk bot paused a routine by itself, after its owner left: no AI of theirs is signed in here any more, they
 * removed every connected app and server, or the plan was cancelled. It turns back on once that changes. */
export type RoutineHoldCause = "plan_cancelled" | "no_engine" | "no_connections";

/** `cap`: it, or its bot, reached the weekly cap set on it; `failures`: its last runs failed the same way. */
export type RoutinePause = { by: "cap"; capUsd: number; at: number } | { by: "failures"; error: string; at: number };
export const ROUTINE_HOLD_CAUSES: readonly RoutineHoldCause[] = ["plan_cancelled", "no_engine", "no_connections"];

/** What a finished run left in the chat it reports to: nothing, because it
 * found nothing to tell; a report waiting for a turn there to end; or the bot
 * message it wrote. */
export type RoutineRunReport =
  | { state: "quiet" }
  | { state: "pending" }
  | { state: "posted"; threadId: string; messageId: string };

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

/** Why a run started a second time by itself: its engine stalled, dusk bot
 * restarted while it ran, the provider rate-limited it or failed for a moment,
 * it waited for its engine's usage limit to reset, or it failed some other way.
 * A run gets one. */
export type RoutineRetryCause = "stalled" | "restarted" | "rate_limited" | "provider" | "usage_limit" | "failed";

/** The statuses both failure indicators count: a run that went wrong and has
 * not been acknowledged. */
export const ROUTINE_PROBLEM_STATUSES: readonly RoutineRunStatus[] = ["failed", "missed"];

export function isRoutineProblemRun(run: { status: RoutineRunStatus }): boolean {
  return ROUTINE_PROBLEM_STATUSES.includes(run.status);
}

export interface Routine extends RoutineQuietFields {
  id: string;
  name: string;
  prompt: string;
  target: RoutineTarget;
  botId: string;
  /** The room a "room-goal" runs in; none runs the goal in the bot's own one-on-one chat, a room of one. */
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  /** Optional wall-clock safety limit. Missing means the run is unlimited. */
  timeoutMinutes?: number;
  overlap?: "skip" | "queue";
  /** Each run starts with the previous run's report. */
  continuity?: boolean;
  /** Also run once each time dusk bot starts. */
  runOnStartup?: boolean;
  checks?: RoutineCheck[];
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  /** When its checks last read everything and found nothing for the AI. */
  checkedAt?: number;
  /** A plain sentence while its checks cannot read an app, so a failed read never looks like nothing new. */
  checkTrouble?: string;
  /** The next time its checks have something to do on time (a reminder, meeting prep): only this may keep the
   * computer awake or wake a sleeping Cloud. */
  wakeAt?: number;
  skippedRuns?: number;
  lastSkippedAt?: number;
  failureStreak?: number;
  /** Runs that finished in the last seven days, and how many of them completed. */
  weekRuns?: { ok: number; total: number };
  /** A plain sentence when the routine names a path that cannot exist on the computer that runs it. */
  warning?: string;
  /** Set while dusk bot keeps it paused because its owner left; turning it on or off clears it. */
  heldFor?: RoutineHoldCause;
  /** Why dusk bot turned it off by itself; gone once it is turned back on. */
  pausedFor?: RoutinePause;
  attachments?: RoutineContextAttachment[];
  sourceThreadId?: string;
  resultsThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  goalStatus?: RoutineGoalStatus;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** A test: outbound actions are refused and become drafts in its reply. */
  dryRun?: true;
  triggerSource?: RoutineRunTrigger;
  /** "app": a connected-app event started it; "wait": a wait's follow-up did. triggerSource is then "webhook" (an outside event). */
  eventSource?: "app" | "wait" | "job";
  webhookId?: string;
  deliveryId?: string;
  /** Room task created for a team-goal run. */
  executionThreadId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  /** A failed run whose reply still came back: only a step it ran failed or wasn't allowed. */
  partial?: boolean;
  /** Set when the run used its one automatic second start, and why. */
  retried?: RoutineRetryCause;
  /** Concise, redacted question or approval reason while status is waiting,
   * or why a queued run starts later. */
  attention?: string;
  cost?: number | null;
  denials?: string[];
  report?: RoutineRunReport;
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  /** The items its routine's checks handed this run, so they are kept or released once it ends. */
  checkKey?: string;
  createdAt: number;
  seenAt?: number;
}

export interface RoutineInput extends RoutineQuietInput {
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineScheduleInput;
  durationMinutes?: number;
  /** `null` explicitly removes the limit; omission preserves it on updates. */
  timeoutMinutes?: number | null;
  overlap?: "skip" | "queue";
  /** Each run starts with the previous run's report. */
  continuity?: boolean;
  runOnStartup?: boolean;
  /** `null` explicitly removes them on updates; omission preserves them. */
  checks?: RoutineCheck[] | null;
  access?: RoutineAccess | null;
  deliver?: RoutineDelivery | null;
  attachments?: RoutineContextAttachment[];
  /** Omission preserves routing; null resets it to the bot's main thread. */
  resultsThreadId?: string | null;
}

export const STRIP_RUNS = 7;
/** A run the self-cap stopped (server/routine-self-cap.ts): cancelled, but its strip shows it as failed. */
export const SELF_CAP_STOP = "Stopped at 3 times its usual cost";

function stripOutcome(run: Pick<RoutineRun, "status" | "report" | "error">): RoutineStripEntry["outcome"] | null {
  if (run.status === "completed") return run.report?.state === "quiet" ? "quiet" : "ok";
  if (run.status === "failed") return "failed";
  if (run.status === "missed") return "missed";
  if (run.status === "cancelled" && run.error?.startsWith(SELF_CAP_STOP)) return "failed";
  return null;
}

/** A routine's last seven outcomes, oldest first: its finished runs (not tests) and its checks' ticks. The server sends
 * it on the routine; the app builds it again from the runs it holds, so it moves the moment a run ends. */
export function runStrip(runs: readonly RoutineRun[], routine: Pick<Routine, "id" | "ticks">, rerun: (runId: string) => boolean = () => false,
  skipped: (runId: string) => boolean = () => false): RoutineStripEntry[] {
  const entries: RoutineStripEntry[] = [...(routine.ticks ?? [])];
  for (const run of runs) {
    if (run.routineId !== routine.id || run.dryRun) continue;
    const outcome = run.status === "missed" && skipped(run.id) ? "skipped" : stripOutcome(run);
    if (outcome) entries.push({ at: run.finishedAt ?? run.scheduledFor, outcome, ...(rerun(run.id) ? { rerun: true as const } : {}) });
  }
  return entries.sort((a, b) => a.at - b.at).slice(-STRIP_RUNS);
}
