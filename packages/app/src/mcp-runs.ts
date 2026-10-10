import type { DelegateEvent, DelegateReceipt } from "./delegate-tasks.js";

// The app-owned record of runs started through the MCP server (#225), shared by every
// connection. The delegate manager forgets a task on its terminal event, so this is what
// delegate_status / list_delegates read — and membership here is the whole cancel scope: an id
// from the chat window, a bot or a routine schedule is simply unknown. In memory only.

export type McpRunState = "running" | "cancelling" | "done" | "failed" | "cancelled";

export interface McpRun {
  id: string;
  kind: "delegate" | "routine";
  /** Display name of the app that started it (initialize.clientInfo.name, sanitized). */
  client: string;
  /** Instruction (delegate) or routine name, cut to 120 chars. */
  instruction: string;
  project: string;
  startedAt: string;
  state: McpRunState;
  /** Latest output lines while running. */
  tail: string[];
  result?: string;
  message?: string;
  receipt?: DelegateReceipt;
  /** Set only when a cancel_delegate call is what ended it. */
  by?: "agent";
  /** The app whose cancel_delegate stopped it (may differ from `client`). */
  cancelledBy?: string;
}

export const MAX_FINISHED_RUNS = 20;
const TAIL_LINES = 20;
const excerpt = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const isActive = (r: McpRun): boolean => r.state === "running" || r.state === "cancelling";

export function createMcpRuns() {
  const runs = new Map<string, McpRun>();
  const cancelRequests = new Map<string, string>(); // id → cancelling client
  const rejected = new Map<string, string>(); // start failures that never got a "started"
  const waiters = new Map<string, Set<() => void>>();

  const wake = (id: string): void => {
    for (const w of waiters.get(id) ?? []) w();
    waiters.delete(id);
  };
  const prune = (): void => {
    const finished = [...runs.values()].filter((r) => !isActive(r));
    // Map keeps insertion order, so the first finished entries are the oldest.
    for (const r of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RUNS))) runs.delete(r.id);
  };

  return {
    add(run: Omit<McpRun, "state" | "tail">): McpRun {
      const r: McpRun = { ...run, instruction: excerpt(run.instruction, 120), state: "running", tail: [] };
      runs.set(r.id, r);
      return r;
    },
    get: (id: string): McpRun | undefined => runs.get(id),
    /** Running first, then newest. */
    list(kind?: McpRun["kind"]): McpRun[] {
      return [...runs.values()].filter((r) => !kind || r.kind === kind)
        .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt.localeCompare(a.startedAt));
    },
    setClient(id: string, client: string): void {
      const r = runs.get(id);
      if (r) r.client = client;
    },
    output(id: string, line: string): void {
      const r = runs.get(id);
      if (!r || !isActive(r)) return;
      r.tail.push(excerpt(line, 500));
      if (r.tail.length > TAIL_LINES) r.tail.shift();
    },
    /** Marks a running run cancelling; false when it isn't running. */
    requestCancel(id: string, client: string): boolean {
      const r = runs.get(id);
      if (r?.state !== "running") return false;
      r.state = "cancelling";
      cancelRequests.set(id, client);
      wake(id);
      return true;
    },
    /** Terminal event. `by: "agent"` only when the confirmed outcome is a cancel we asked for —
     * a normal finish that won the race is reported as what it was. */
    finish(id: string, state: "done" | "failed" | "cancelled", fields: { result?: string; message?: string; receipt?: DelegateReceipt } = {}): McpRun | undefined {
      const r = runs.get(id);
      if (!r || !isActive(r)) return undefined;
      const canceller = cancelRequests.get(id);
      cancelRequests.delete(id);
      Object.assign(r, { state, tail: state === "done" ? [] : r.tail }, fields);
      if (state === "cancelled" && canceller !== undefined) { r.by = "agent"; r.cancelledBy = canceller; }
      wake(id);
      prune();
      return r;
    },
    /** A start that failed before it ever ran (busy project, no CLI) — read once by the starter. */
    reject(id: string, message: string): void { rejected.set(id, message); },
    takeRejection(id: string): string | undefined {
      const m = rejected.get(id);
      rejected.delete(id);
      return m;
    },
    /** Resolves on the run's next state change, after `ms`, or on abort — whichever is first. */
    wait(id: string, ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        if (ms <= 0 || signal?.aborted) { resolve(); return; }
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          waiters.get(id)?.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done);
        const set = waiters.get(id) ?? new Set();
        set.add(done);
        waiters.set(id, set);
      });
    },
  };
}

export type McpRuns = ReturnType<typeof createMcpRuns>;

/** Feeds one event from the MCP delegate instance into the registry. Returns false for an event
 * that shouldn't reach the avatar (a start refused before it ran — start_delegate reports it),
 * else the line a stopped run's bubble should show. */
export function applyDelegateEvent(runs: McpRuns, event: DelegateEvent, projectLabel: (path: string) => string): false | { stopped: string } {
  if (event.type === "started") {
    runs.add({
      id: event.taskId, kind: "delegate", client: "an AI app", instruction: event.instruction,
      project: projectLabel(event.projectPath), startedAt: new Date().toISOString(),
    });
  } else if (event.type === "output") {
    const line = event.line.trim();
    if (line) runs.output(event.taskId, line);
  } else if (!runs.get(event.taskId)) {
    if (event.type === "failed") runs.reject(event.taskId, event.message);
    return false;
  } else if (event.type === "done") runs.finish(event.taskId, "done", { result: event.result, receipt: event.receipt });
  else if (event.type === "failed") runs.finish(event.taskId, "failed", { message: event.message, receipt: event.receipt });
  else {
    const run = runs.finish(event.taskId, "cancelled", { receipt: event.receipt });
    if (run?.by === "agent") return { stopped: `Cancelled by ${run.cancelledBy}` };
  }
  return { stopped: "Stopped" };
}
