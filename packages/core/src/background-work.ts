// background_work (#924): a read-only action tool that answers "what is running, how did it go,
// how many are left" from the data the scheduler, the todo queue and the dispatch rows already
// hold. The owner sees everything; anyone else sees only their own queued todos and the jobs they
// dispatched from this conversation — never another person's task text.
import type { ActionTool } from "./converse.js";
import type { Dispatch } from "./dispatch-store.js";
import { loadRoutineStates } from "./routine-store.js";
import { getTodo, listOpenTodos, type TodoItem } from "./todo-store.js";

export interface BackgroundWorkDeps {
  /** bean.db (todos). */
  file: string;
  /** routines/.state.json (each sprout's last run). */
  stateFile: string;
  /** Live run slots per sprout (`runningNames`/`runningCount`). Absent or resolving undefined =
   * this process can't see the scheduler right now (reported as unknown). */
  running?: () => Promise<{ name: string; runs: number }[] | undefined>;
  /** The jobs dispatched from this conversation, any order. */
  dispatches: () => Dispatch[];
  /** Set = a non-owner speaker's platform id: only their own todos and jobs. Absent = the owner. */
  viewer?: string;
}

// Bounds on what one tool result carries back into the model's context.
const MAX_JOBS = 10;
const MAX_TEXT = 300;
const MAX_RESULT = 600;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

type JobState = "queued" | "running" | Exclude<Dispatch["status"], undefined>;

export interface BackgroundWorkReport {
  /** Owner only: sprouts with a run going now. "unknown" = the scheduler isn't reachable from here. */
  running?: { sprout: string; runs: number }[] | "unknown";
  /** Owner only: open todos per sprout. */
  queues?: { sprout: string; pending: number; running: number }[];
  /** Non-owner only: their own open todos. `position` = 1 is the next one the sprout takes. */
  myTodos?: { id: string; sprout: string; text: string; status: "pending" | "running"; position?: number }[];
  /** Jobs dispatched from this conversation, newest first. */
  dispatched: { job: string; sprout: string; task?: string; state: JobState; position?: number; result?: string; at: string; finishedAt?: string }[];
  /** Owner only: each sprout's last finished run. */
  lastResults?: { sprout: string; status: string; finishedAt: string; summary?: string }[];
}

/** 1-based place among the sprout's pending todos (queue order = `claimTodo`'s), or undefined. */
function positions(open: TodoItem[]): Map<string, number> {
  const out = new Map<string, number>();
  const bySprout = new Map<string, TodoItem[]>();
  for (const t of open) if (t.status === "pending") bySprout.set(t.routine, [...(bySprout.get(t.routine) ?? []), t]);
  for (const list of bySprout.values()) {
    list.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    list.forEach((t, i) => out.set(t.id, i + 1));
  }
  return out;
}

export async function backgroundWork(deps: BackgroundWorkDeps): Promise<BackgroundWorkReport> {
  const owner = deps.viewer === undefined;
  const open = await listOpenTodos(deps.file);
  const pos = positions(open);
  const openById = new Map(open.map((t) => [t.id, t]));

  const jobs = deps.dispatches()
    .map((d) => ({ d, todo: d.todoId ? openById.get(d.todoId) ?? getTodo(deps.file, d.todoId) : undefined }))
    // A non-owner sees a job only if they tapped it or queued its todo.
    .filter(({ d, todo }) => owner || d.actor === deps.viewer || (todo?.createdBy !== undefined && todo.createdBy === deps.viewer))
    .sort((a, b) => b.d.createdAt.localeCompare(a.d.createdAt))
    .slice(0, MAX_JOBS)
    .map(({ d, todo }) => {
      const state: JobState = d.status ?? (todo?.status === "pending" ? "queued" : "running");
      const position = todo && state === "queued" ? pos.get(todo.id) : undefined;
      return {
        job: d.id, sprout: d.routine, ...(todo ? { task: clip(todo.text, MAX_TEXT) } : {}), state,
        ...(position !== undefined ? { position } : {}),
        ...(d.brief ? { result: clip(d.brief, MAX_RESULT) } : {}),
        at: d.createdAt, ...(d.finishedAt ? { finishedAt: d.finishedAt } : {}),
      };
    });

  if (!owner) {
    const mine = open.filter((t) => t.createdBy === deps.viewer).map((t) => ({
      id: t.id, sprout: t.routine, text: clip(t.text, MAX_TEXT), status: t.status as "pending" | "running",
      ...(pos.has(t.id) ? { position: pos.get(t.id) } : {}),
    }));
    return { myTodos: mine, dispatched: jobs };
  }

  const queues = new Map<string, { sprout: string; pending: number; running: number }>();
  for (const t of open) {
    const q = queues.get(t.routine) ?? { sprout: t.routine, pending: 0, running: 0 };
    if (t.status === "pending") q.pending++;
    else q.running++;
    queues.set(t.routine, q);
  }
  const live = await deps.running?.().catch(() => undefined);
  const states = await loadRoutineStates(deps.stateFile);
  const lastResults = Object.entries(states).flatMap(([sprout, s]) => {
    const last = s.history[0];
    return last ? [{ sprout, status: last.status, finishedAt: last.finishedAt, ...(last.digest ? { summary: clip(last.digest, MAX_TEXT) } : {}) }] : [];
  });
  return {
    running: live ? live.filter((r) => r.runs > 0).map((r) => ({ sprout: r.name, runs: r.runs })) : "unknown",
    queues: [...queues.values()],
    dispatched: jobs,
    lastResults,
  };
}

export function makeBackgroundWorkTool(deps: BackgroundWorkDeps): ActionTool {
  return {
    spec: {
      name: "background_work",
      description: "Read-only status of Bean's background sprout work: which sprouts are running now, how many todos are "
        + "queued, the jobs dispatched from this conversation with their outcome and queue position, and each sprout's "
        + "last result. Use it to answer what's running, how a dispatched task went, or how many are left.",
      parameters: { type: "object", properties: {} },
    },
    run: async () => JSON.stringify(await backgroundWork(deps)),
  };
}
