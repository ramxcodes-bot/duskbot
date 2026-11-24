import type { Routine, RoutineRun, RoutineStripEntry } from "./routines";
import { runStrip } from "../../shared/routines";
import en from "@/locales/en.json";
import { activeLocale, t } from "./i18n";
import { deviceHourCycle } from "@/lib/format-time";

export function routineRunTime(run: RoutineRun): number {
  return run.createdAt || run.startedAt || run.scheduledFor;
}

/** A run that failed only because a step did, after its reply came back. */
export function partlyDone(run: RoutineRun): boolean {
  return run.status === "failed" && run.partial === true && !run.goalStatus;
}

export function routineRunLabel(run: RoutineRun): string {
  if (run.goalStatus) return t(`routines.goal.${run.goalStatus}`);
  const status = t(partlyDone(run) ? "routines.status.partial" : `routines.status.${run.status}`);
  return run.retried && run.status !== "queued" ? t(`routines.retried.${run.retried}`, { status }) : status;
}

export function routineRunTone(run: RoutineRun): string {
  if (run.status === "waiting" || partlyDone(run) || ["needs-input", "limit-reached", "paused"].includes(run.goalStatus ?? "")) return "text-warning";
  if (["failed", "missed"].includes(run.status) || ["failed", "blocked"].includes(run.goalStatus ?? "")) return "text-danger";
  if (run.status === "running") return "text-accent";
  if (run.status === "completed" && (!run.goalStatus || run.goalStatus === "completed")) return "text-success";
  return "text-ink-secondary";
}

export function routineDateTime(at: number): string {
  return new Date(at).toLocaleString(activeLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: deviceHourCycle() });
}

export function routineFinished(routine: Routine): boolean {
  return routine.schedule.type === "once" && routine.nextRunAt == null && routine.schedule.at <= Date.now();
}

export function routineScheduleState(routine: Routine): string {
  if (routineFinished(routine)) return t("routines.finishedSchedule");
  return routine.enabled ? t("routines.activeSchedule") : t("routines.pausedSchedule");
}

export function routineNextLabel(routine: Routine): string {
  if (!routine.enabled) return routineScheduleState(routine);
  return routine.nextRunAt == null ? t("routines.noNextRun") : t("routines.nextRun", { time: routineDateTime(routine.nextRunAt) });
}

export function routineRunsOn({ roomGoal, runOn, computer, cloudHome }: {
  roomGoal: boolean; runOn?: string; computer?: string | null; cloudHome: boolean;
}): { label: string; hint: string } {
  const hint = t(cloudHome ? "routines.runsOn.cloudHomeHint" : "routines.runsOn.localHint");
  if (roomGoal) return { label: t(cloudHome ? "routines.runsOn.teamCloudHome" : "routines.runsOn.team"), hint };
  if (runOn === "cloud") return { label: t("routines.runsOn.cloudDesktop"), hint: t(cloudHome ? "routines.runsOn.cloudDesktopHintCloudHome" : "routines.runsOn.cloudDesktopHint") };
  if (computer === "cloud") return { label: t("routines.runsOn.botCloud"), hint };
  if (computer === "vm" && !cloudHome) return { label: t("routines.runsOn.botVm"), hint };
  return { label: t(cloudHome ? "routines.runsOn.cloudHome" : "routines.runsOn.local"), hint };
}

const clockText = (time: string) => {
  const [hour, minute] = time.split(":").map(Number);
  return new Date(2026, 0, 1, hour ?? 0, minute ?? 0).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit", hourCycle: deviceHourCycle() });
};

/** "Runs 7:00 AM to 11:00 PM, quiet at night" for a routine that runs only in some hours; null for one that runs all day. */
export function hoursLine(schedule: Routine["schedule"]): string | null {
  return schedule.type === "interval" && schedule.window ? t("routines.hours.quiet", { start: clockText(schedule.window.start), end: clockText(schedule.window.end) }) : null;
}

/** "Changes to example.com", "New posts in example.com/feed", "The price on shop.example". */
export function probeLine(probe: NonNullable<Routine["probe"]>): string {
  if (probe.kind === "script") {
    const line = t(probe.post ? "routines.probe.scriptPost" : "routines.probe.script", { place: probe.command ?? "" });
    return probe.access === "full" ? `${line}. ${t("routines.probe.scriptFullAccess")}` : line;
  }
  let place = probe.url;
  try { const url = new URL(probe.url); place = url.hostname + (url.pathname.length > 1 ? url.pathname : ""); } catch { /* as given */ }
  return t(`routines.probe.${probe.kind}`, { place });
}

/** The strip from the runs the app holds, so it moves the moment a run ends; the server's own says which were free
 * re-runs after an update problem and which the weekly limit skipped. */
export function liveStrip(routine: Routine, runs: readonly RoutineRun[]): RoutineStripEntry[] {
  const server = routine.strip ?? [];
  const reruns = new Set(server.filter((entry) => entry.rerun).map((entry) => entry.at));
  const skipped = new Set(server.filter((entry) => entry.outcome === "skipped").map((entry) => entry.at));
  return runStrip(runs, routine).map((entry) => ({
    ...entry,
    ...(reruns.has(entry.at) ? { rerun: true as const } : {}),
    ...(entry.outcome === "missed" && skipped.has(entry.at) ? { outcome: "skipped" as const } : {}),
  }));
}

const templatePattern = (template: string) =>
  new RegExp(`^${template.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")).join("[\\s\\S]+")}$`);

/** A run the account's weekly limit skipped (the server's line, in the app's language or English): no failure, nothing
 * to fix, only "skipped: weekly limit" on its strip. */
export function isLimitSkip(run: Pick<RoutineRun, "status" | "error">): boolean {
  if (run.status !== "missed" || !run.error) return false;
  return [t("server.allowance.held"), en["server.allowance.held"]].some((template) => templatePattern(template).test(run.error!));
}
