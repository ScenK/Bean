import type {
  BuildStage, Routine, RoutineBrief, RoutineState, RoutineWatch, RunRecord, RunStatus, StepKind, WatchCheckResult, WatchItem,
} from "@bean/core";

/** One in-flight (or failed) build, as the Routines list and the 2b screen show it. A successful
 * build leaves no entry: the saved-disabled routine itself is the "needs review" row. */
export interface RoutineBuildView {
  name: string;
  brief: RoutineBrief;
  status: "building" | "failed";
  stage: BuildStage;
  detail?: string;
  startedAt: string;
  error?: string;
  exitCode?: number;
}

export interface RoutineStateView {
  lastRun?: string; missed?: boolean; history: RunRecord[]; running: boolean;
  /** Live runs (taken slots); `running` also covers a tick still deciding. */
  runningCount: number;
  /** Todo-driven routines only. */
  queue?: { pending: number; running: number };
  /** Watch routines only. */
  lastPoll?: string; pollError?: string; pollFailures?: number;
  /** false = never enabled since its source was set — the list shows "needs review". */
  seeded?: boolean;
}

/** One executed step of a run, for the Dashboard's full-output view. `resume` is Bean's own
 * resume command for a delegate session (never model-written). */
export interface StepAttemptView {
  stepIndex: number; stepId?: string; round: number; kind: StepKind; cli?: string;
  ok: boolean; verdict?: string; output: string; resume?: string;
}

/** Who a chatops sink with no channel reaches (counts only — the app can't look up names). */
export interface SinkRecipients { discord?: number; teams?: number }
export interface BriefDraft { brief: RoutineBrief; tools: string[] }

/** Watch + builder verbs. Optional so tests (and a boot without them) can omit the lot. */
export interface RoutineWatchDeps {
  isSeeded: (routine: Routine) => boolean;
  pollFailures: (name: string) => number;
  checkNow: (name: string) => Promise<WatchCheckResult>;
  previewWatch: (watch: RoutineWatch) => Promise<WatchItem[]>;
  enableWatch: (name: string, queueExisting: boolean) => Promise<{ count: number }>;
  sinkRecipients: () => Promise<SinkRecipients>;
  draftBrief: (sentence: string, previous?: RoutineBrief) => Promise<BriefDraft>;
  builds: {
    list: () => RoutineBuildView[];
    start: (brief: RoutineBrief) => Promise<void>;
    cancel: (name: string) => void;
    dismiss: (name: string) => void;
  };
}

export interface RoutineHandlerDeps {
  loadRoutines: () => Promise<Routine[]>;
  saveRoutine: (routine: Routine) => Promise<void>;
  deleteRoutine: (name: string) => Promise<void>;
  loadStates: () => Promise<Record<string, RoutineState>>;
  isRunning: (name: string) => boolean;
  runningCount: (name: string) => number;
  queueCounts?: (name: string) => Promise<{ pending: number; running: number }>;
  runNow: (name: string) => Promise<{ started: boolean; reason?: string; status?: RunStatus; stopped?: true }>;
  /** Stops the sprout's live runs (the scheduler's `stopRuns`); only called for a running name. */
  stopRuns?: (name: string) => void;
  onRoutineDeleted?: (name: string) => Promise<void>;
  /** A run's step attempts (bean.db), oldest first. */
  attempts?: (runId: string) => StepAttemptView[];
  watch?: RoutineWatchDeps;
}

export function buildRoutineHandlers(deps: RoutineHandlerDeps) {
  const watch = (): RoutineWatchDeps => {
    if (!deps.watch) throw new Error("watch sprouts aren't available");
    return deps.watch;
  };
  return {
    list: (): Promise<Routine[]> => deps.loadRoutines(),
    save: async (routine: Routine): Promise<void> => {
      await deps.saveRoutine(routine);
    },
    remove: async (name: string): Promise<void> => {
      await deps.deleteRoutine(name);
      await deps.onRoutineDeleted?.(name);
    },
    state: async (): Promise<Record<string, RoutineStateView>> => {
      const [routines, states] = await Promise.all([deps.loadRoutines(), deps.loadStates()]);
      const out: Record<string, RoutineStateView> = {};
      for (const r of routines) {
        const s = states[r.name];
        out[r.name] = {
          lastRun: s?.lastRun, missed: s?.missed, history: s?.history ?? [],
          running: deps.isRunning(r.name), runningCount: deps.runningCount(r.name),
          ...(r.todoDriven && deps.queueCounts ? { queue: await deps.queueCounts(r.name) } : {}),
        };
        if (r.watch && deps.watch) {
          Object.assign(out[r.name]!, {
            lastPoll: s?.lastPoll, pollError: s?.pollError, pollFailures: deps.watch.pollFailures(r.name),
            seeded: deps.watch.isSeeded(r),
          });
        }
      }
      return out;
    },
    runNow: (name: string): Promise<{ started: boolean; reason?: string; status?: RunStatus; stopped?: true }> => deps.runNow(name),
    /** A renderer payload: anything but a running sprout's name is ignored. */
    stop: (name: unknown): void => {
      if (typeof name === "string" && deps.isRunning(name)) deps.stopRuns?.(name);
    },
    attempts: (runId: string): StepAttemptView[] => (typeof runId === "string" && runId ? deps.attempts?.(runId) ?? [] : []),
    checkNow: (name: string): Promise<WatchCheckResult> => watch().checkNow(name),
    previewWatch: (w: RoutineWatch): Promise<WatchItem[]> => watch().previewWatch(w),
    enableWatch: (name: string, queueExisting: boolean): Promise<{ count: number }> => watch().enableWatch(name, queueExisting === true),
    sinkRecipients: (): Promise<SinkRecipients> => watch().sinkRecipients(),
    draftBrief: (sentence: string, previous?: RoutineBrief): Promise<BriefDraft> => {
      if (typeof sentence !== "string" || !sentence.trim()) throw new Error("describe the sprout first");
      return watch().draftBrief(sentence.trim().slice(0, 2000), previous);
    },
    build: (brief: RoutineBrief): Promise<void> => watch().builds.start(brief),
    builds: (): RoutineBuildView[] => deps.watch?.builds.list() ?? [],
    cancelBuild: (name: string): void => watch().builds.cancel(name),
    dismissBuild: (name: string): void => watch().builds.dismiss(name),
  };
}
