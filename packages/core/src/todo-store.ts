import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { closeTodoDispatches, openDispatch, type DispatchSurface } from "./dispatch-store.js";

export type TodoStatus = "pending" | "running" | "done" | "failed";

/** One consume-once queue item owned by a todo-driven routine. Plain text only — the
 * routine's steps supply skill/project/model; the text is the task context. */
export interface TodoItem {
  id: string;
  routine: string;
  text: string;
  status: TodoStatus;
  createdAt: string;   // ISO
  finishedAt?: string; // ISO, set on done/failed
  resultSummary?: string;
  order: number;
  /** The non-owner chatops speaker who queued it; absent = the owner's. */
  createdBy?: string;
}

interface TodoRow {
  id: string; routine: string; text: string; status: string;
  created_at: string; finished_at: string | null; result_summary: string | null; ord: number;
  created_by: string | null;
}

const SELECT = "SELECT id, routine, text, status, created_at, finished_at, result_summary, ord, created_by FROM todos";

function toItem(r: TodoRow): TodoItem {
  return {
    id: r.id, routine: r.routine, text: r.text, status: r.status as TodoStatus,
    createdAt: r.created_at, finishedAt: r.finished_at ?? undefined,
    resultSummary: r.result_summary ?? undefined, order: r.ord,
    ...(r.created_by ? { createdBy: r.created_by } : {}),
  };
}

export async function addTodo(
  file: string, routine: string, text: string,
  newId: () => string = randomUUID, now: () => Date = () => new Date(),
  createdBy?: string,
): Promise<TodoItem> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("todo text is required");
  if (!routine.trim()) throw new Error("todo sprout is required");
  const db = openDb(file);
  const item: TodoItem = {
    id: newId(), routine, text: trimmed, status: "pending", createdAt: now().toISOString(), order: 0,
    ...(createdBy ? { createdBy } : {}),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const max = db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM todos WHERE routine = ?").get(routine) as unknown as { m: number };
    item.order = max.m + 1;
    db.prepare("INSERT INTO todos (id, routine, text, status, created_at, ord, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(item.id, item.routine, item.text, item.status, item.createdAt, item.order, createdBy ?? null);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return item;
}

/** Where a todo's result goes back to (#923): the conversation it was queued from. */
export interface TodoOrigin { surface: DispatchSurface; conversation?: string; actor?: string; keepBrief?: boolean }

/** Queues a todo together with its dispatch row (#923), in one transaction: the row is never seen
 * without its pending todo, so a scheduler-holder start (which keeps rows whose todo is pending)
 * can't close it as interrupted — any process on this bean.db may call it. `front` = ahead of every
 * queued todo (Run now). `ahead` = the routine's pending todos it waits behind. */
export function queueTodoDispatch(
  file: string, t: { routine: string; text: string; createdBy?: string; front?: boolean }, origin: TodoOrigin,
  newId: () => string = randomUUID, now: () => Date = () => new Date(),
): { todo: TodoItem; jobId: string; ahead: number } {
  const text = t.text.trim();
  if (!text) throw new Error("todo text is required");
  if (!t.routine.trim()) throw new Error("todo sprout is required");
  const db = openDb(file);
  const item: TodoItem = {
    id: newId(), routine: t.routine, text, status: "pending", createdAt: now().toISOString(), order: 0,
    ...(t.createdBy ? { createdBy: t.createdBy } : {}),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const { lo, hi, pending } = db.prepare(
      "SELECT COALESCE(MIN(ord), 1) AS lo, COALESCE(MAX(ord), 0) AS hi, SUM(status = 'pending') AS pending FROM todos WHERE routine = ?",
    ).get(t.routine) as unknown as { lo: number; hi: number; pending: number | null };
    item.order = t.front ? lo - 1 : hi + 1;
    db.prepare("INSERT INTO todos (id, routine, text, status, created_at, ord, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(item.id, item.routine, item.text, item.status, item.createdAt, item.order, t.createdBy ?? null);
    const jobId = openDispatch(file, { ...origin, routine: t.routine, todoId: item.id }, newId, now);
    db.exec("COMMIT");
    return { todo: item, jobId, ahead: t.front ? 0 : pending ?? 0 };
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

/** The routine's pending todos — what a new one would wait behind. */
export function pendingTodoCount(file: string, routine: string): number {
  return (openDb(file).prepare("SELECT COUNT(*) AS n FROM todos WHERE routine = ? AND status = 'pending'").get(routine) as unknown as { n: number }).n;
}

export async function listTodos(file: string, routine: string): Promise<TodoItem[]> {
  const rows = openDb(file).prepare(`${SELECT} WHERE routine = ? ORDER BY ord ASC, created_at ASC`)
    .all(routine) as unknown as TodoRow[];
  return rows.map(toItem);
}

export async function listAllTodos(file: string): Promise<TodoItem[]> {
  const rows = openDb(file).prepare(`${SELECT} ORDER BY routine ASC, ord ASC`).all() as unknown as TodoRow[];
  return rows.map(toItem);
}

export async function updateTodoStatus(
  file: string, id: string, status: TodoStatus, resultSummary?: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const finished = status === "done" || status === "failed";
  const db = openDb(file);
  // One transaction: a dispatch following this todo (#919) closes with the todo's own result,
  // whichever run took it — never a finished todo whose dispatch a restart then calls interrupted.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE todos SET status = ?, finished_at = ?, result_summary = ? WHERE id = ?")
      .run(status, finished ? now().toISOString() : null, resultSummary ?? null, id);
    if (finished) {
      const runStatus = status === "done" ? "ok" : resultSummary?.startsWith("needs attention:") ? "needs-attention" : "failed";
      closeTodoDispatches(file, id, runStatus, resultSummary, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

/** Atomically moves the routine's first pending todo (queue order) to `running` and returns it;
 * undefined = nothing pending. One statement, so two drains can never claim the same todo, and
 * an edit/cancel (pending-only) can't land on a todo once it's claimed. */
export async function claimTodo(file: string, routine: string): Promise<TodoItem | undefined> {
  const row = openDb(file).prepare(
    "UPDATE todos SET status = 'running' WHERE id = (SELECT id FROM todos WHERE routine = ? AND status = 'pending' ORDER BY ord ASC, created_at ASC LIMIT 1) " +
    "AND status = 'pending' RETURNING id, routine, text, status, created_at, finished_at, result_summary, ord, created_by",
  ).get(routine) as unknown as TodoRow | undefined;
  return row ? toItem(row) : undefined;
}

/** Exact-todo claim (Run now, #923): this one todo pending → running, or undefined when a drain
 * already took it (or it was cancelled). */
export async function claimTodoById(file: string, id: string): Promise<TodoItem | undefined> {
  const row = openDb(file).prepare(
    "UPDATE todos SET status = 'running' WHERE id = ? AND status = 'pending' " +
    "RETURNING id, routine, text, status, created_at, finished_at, result_summary, ord, created_by",
  ).get(id) as unknown as TodoRow | undefined;
  return row ? toItem(row) : undefined;
}

export async function editTodoText(file: string, id: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("todo text is required");
  const changed = openDb(file).prepare("UPDATE todos SET text = ? WHERE id = ? AND status = 'pending'").run(trimmed, id);
  if (changed.changes === 0) throw new Error("only pending todos can be edited");
}

export async function reorderTodo(file: string, id: string, newOrder: number): Promise<void> {
  openDb(file).prepare("UPDATE todos SET ord = ? WHERE id = ?").run(newOrder, id);
}

/** Chatops list: pending/running todos across routines. `createdBy` set = only that speaker's
 * (non-owners — filtered in SQL); absent = everyone's (the owner). */
export async function listOpenTodos(file: string, createdBy?: string): Promise<TodoItem[]> {
  const open = `${SELECT} WHERE status IN ('pending', 'running')`;
  const rows = (createdBy === undefined
    ? openDb(file).prepare(`${open} ORDER BY routine ASC, ord ASC`).all()
    : openDb(file).prepare(`${open} AND created_by = ? ORDER BY routine ASC, ord ASC`).all(createdBy)) as unknown as TodoRow[];
  return rows.map(toItem);
}

/** Chatops cancel: deletes one pending todo. `createdBy` set = only if that speaker queued it
 * (non-owners — enforced in SQL). False = no such pending todo (or not theirs). */
export async function cancelPendingTodo(file: string, id: string, createdBy?: string): Promise<boolean> {
  const del = "DELETE FROM todos WHERE id = ? AND status = 'pending'";
  const changed = createdBy === undefined
    ? openDb(file).prepare(del).run(id)
    : openDb(file).prepare(`${del} AND created_by = ?`).run(id, createdBy);
  if (changed.changes > 0) dropTodoDispatch(file, id);
  return changed.changes > 0;
}

export async function deleteTodo(file: string, id: string): Promise<void> {
  openDb(file).prepare("DELETE FROM todos WHERE id = ?").run(id);
  dropTodoDispatch(file, id);
}

/** A removed todo never runs: its still-open dispatch rows go too, so no restart later reports it
 * as interrupted. */
function dropTodoDispatch(file: string, id: string): void {
  openDb(file).prepare("DELETE FROM sprout_dispatches WHERE todo_id = ? AND status IS NULL").run(id);
}

export async function clearFinishedTodos(file: string, routine: string): Promise<void> {
  openDb(file).prepare("DELETE FROM todos WHERE routine = ? AND status IN ('done', 'failed')").run(routine);
}

export async function retryTodo(file: string, id: string): Promise<void> {
  const changed = openDb(file)
    .prepare("UPDATE todos SET status = 'pending', finished_at = NULL, result_summary = NULL WHERE id = ? AND status = 'failed'")
    .run(id);
  if (changed.changes === 0) throw new Error("only failed todos can be retried");
}

/** Startup recovery: anything still `running` was interrupted by a quit/crash mid-run.
 * Marked failed ("interrupted") — visible and retryable, never silently lost. */
export async function recoverInterruptedTodos(file: string, now: () => Date = () => new Date()): Promise<number> {
  const changed = openDb(file)
    .prepare("UPDATE todos SET status = 'failed', finished_at = ?, result_summary = 'interrupted' WHERE status = 'running'")
    .run(now().toISOString());
  return Number(changed.changes);
}

export async function renameTodosRoutine(file: string, from: string, to: string): Promise<void> {
  openDb(file).prepare("UPDATE todos SET routine = ? WHERE routine = ?").run(to, from);
}

export async function deleteTodosForRoutine(file: string, routine: string): Promise<void> {
  openDb(file).prepare("DELETE FROM sprout_dispatches WHERE status IS NULL AND todo_id IN (SELECT id FROM todos WHERE routine = ?)").run(routine);
  openDb(file).prepare("DELETE FROM todos WHERE routine = ?").run(routine);
}
