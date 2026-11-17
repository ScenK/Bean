// packages/core/src/dispatch-store.ts
// Sprout runs dispatched from a conversation (#919): `bean.db`'s `sprout_dispatches` remembers
// where each came from, so its result reaches that conversation even across a core restart.
// Written only by the scheduler-lease holder: its start closes every row still open as
// "interrupted" (nothing is re-run), so a standby host must never open one.
import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import type { TriggerResult } from "./routine-scheduler.js";
import type { RunStatus } from "./routine-store.js";
import { sproutFinishText, type SproutOrigin, type SproutTrigger } from "./sprout-trigger.js";

export type DispatchSurface = "desktop" | "discord" | "teams";
export type DispatchStatus = RunStatus | "interrupted";

export interface Dispatch {
  id: string;
  surface: DispatchSurface;
  /** Chatops channel (absent = the owner's DM); desktop = the chat thread id. */
  conversation?: string;
  actor?: string;
  routine: string;
  /** Set = the row follows this todo: it closes when the todo finishes, whichever run took it. */
  todoId?: string;
  runIds: string[];
  /** Absent = still open. */
  status?: DispatchStatus;
  brief?: string;
  createdAt: string;
  finishedAt?: string;
  deliveredAt?: string;
}

interface DispatchRow {
  id: string; surface: string; conversation: string | null; actor: string | null; routine: string;
  todo_id: string | null; run_ids: string | null; status: string | null; brief: string | null;
  created_at: string; finished_at: string | null; delivered_at: string | null;
}

const SELECT = "SELECT id, surface, conversation, actor, routine, todo_id, run_ids, status, brief, created_at, finished_at, delivered_at FROM sprout_dispatches";

function toDispatch(r: DispatchRow): Dispatch {
  return {
    id: r.id, surface: r.surface as DispatchSurface, routine: r.routine,
    runIds: r.run_ids ? (JSON.parse(r.run_ids) as string[]) : [], createdAt: r.created_at,
    ...(r.conversation !== null ? { conversation: r.conversation } : {}),
    ...(r.actor !== null ? { actor: r.actor } : {}),
    ...(r.todo_id !== null ? { todoId: r.todo_id } : {}),
    ...(r.status !== null ? { status: r.status as DispatchStatus } : {}),
    ...(r.brief !== null ? { brief: r.brief } : {}),
    ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
    ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}),
  };
}

/** Delivered rows older than this are pruned at the scheduler's start. */
export const DISPATCH_RETENTION_DAYS = 30;

/** Records a dispatch at admission. `keepBrief: false` (an incognito desktop chat) = the row never
 * stores the run's brief. Returns the job id. */
export function openDispatch(file: string, d: {
  surface: DispatchSurface; conversation?: string; actor?: string; routine: string; todoId?: string; keepBrief?: boolean;
}, newId: () => string = randomUUID, now: () => Date = () => new Date()): string {
  const id = newId();
  openDb(file).prepare(
    "INSERT INTO sprout_dispatches (id, surface, conversation, actor, routine, todo_id, keep_brief, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, d.surface, d.conversation ?? null, d.actor ?? null, d.routine, d.todoId ?? null, d.keepBrief === false ? 0 : 1, now().toISOString());
  return id;
}

/** Closes an open, run-linked dispatch (a todo-linked one closes with its todo instead). False =
 * already closed, todo-linked, or unknown — a duplicate completion changes nothing. */
export function closeDispatch(file: string, id: string, end: { status: DispatchStatus; runIds?: string[]; brief?: string }, now: () => Date = () => new Date()): boolean {
  const changed = openDb(file).prepare(
    "UPDATE sprout_dispatches SET status = ?, run_ids = ?, brief = CASE WHEN keep_brief = 1 THEN ? END, finished_at = ? " +
    "WHERE id = ? AND status IS NULL AND todo_id IS NULL",
  ).run(end.status, end.runIds?.length ? JSON.stringify(end.runIds) : null, end.brief ?? null, now().toISOString(), id);
  return changed.changes > 0;
}

/** A todo finished: closes the open dispatches that follow it, with the todo's own result. */
export function closeTodoDispatches(file: string, todoId: string, status: RunStatus, brief: string | undefined, now: () => Date = () => new Date()): void {
  openDb(file).prepare(
    "UPDATE sprout_dispatches SET status = ?, brief = CASE WHEN keep_brief = 1 THEN ? END, finished_at = ? WHERE todo_id = ? AND status IS NULL",
  ).run(status, brief ?? null, now().toISOString(), todoId);
}

/** Scheduler start (lease holder only): every dispatch still open lost its run to the restart —
 * closed as interrupted, owed a notice. A todo-linked row whose todo is still pending is kept: its
 * todo runs on a later drain. Also prunes delivered rows past the retention. Returns how many
 * were interrupted. */
export function interruptOpenDispatches(file: string, now: () => Date = () => new Date()): number {
  const db = openDb(file);
  const at = now();
  db.prepare("DELETE FROM sprout_dispatches WHERE delivered_at IS NOT NULL AND delivered_at < ?")
    .run(new Date(at.getTime() - DISPATCH_RETENTION_DAYS * 86_400_000).toISOString());
  const changed = db.prepare(
    "UPDATE sprout_dispatches SET status = 'interrupted', finished_at = ? WHERE status IS NULL " +
    "AND (todo_id IS NULL OR todo_id NOT IN (SELECT id FROM todos WHERE status = 'pending'))",
  ).run(at.toISOString());
  return Number(changed.changes);
}

export function getDispatch(file: string, id: string): Dispatch | undefined {
  const row = openDb(file).prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as DispatchRow | undefined;
  return row ? toDispatch(row) : undefined;
}

/** Closed dispatches whose result hasn't reached their origin yet, oldest first. */
export function undeliveredDispatches(file: string): Dispatch[] {
  return (openDb(file).prepare(`${SELECT} WHERE status IS NOT NULL AND delivered_at IS NULL ORDER BY created_at ASC`)
    .all() as unknown as DispatchRow[]).map(toDispatch);
}

/** The line a closed dispatch posts at its origin: the fixed finish line, then its brief. */
export function dispatchNotice(d: Dispatch): string {
  const line = sproutFinishText(d.routine, d.status ?? "failed");
  return d.brief ? `${line}\n\n${d.brief}` : line;
}

/** Sends every owed result once. A row is claimed (delivered_at set) before `deliver`, so two
 * sweeps never send it twice; `deliver` resolving false (this origin can't take it here) or
 * throwing un-claims it for a later sweep. */
export async function deliverDispatches(file: string, deliver: (d: Dispatch) => Promise<boolean>, now: () => Date = () => new Date()): Promise<void> {
  const db = openDb(file);
  for (const d of undeliveredDispatches(file)) {
    const claimed = db.prepare("UPDATE sprout_dispatches SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(now().toISOString(), d.id);
    if (claimed.changes === 0) continue;
    let sent = false;
    try {
      sent = await deliver(d);
    } catch (err) {
      console.error(`bean: delivering sprout dispatch ${d.id} failed`, err);
    }
    if (!sent) db.prepare("UPDATE sprout_dispatches SET delivered_at = NULL WHERE id = ?").run(d.id);
  }
}

/** Wraps the scheduler's trigger for a chat surface: an admitted run is recorded at its origin
 * and closed at its end, then `deliver` (the owed-results sweep) posts it. Replaces the old
 * in-memory finish closure, which a restart mid-run dropped. */
export function withDispatch(
  trigger: (name: string, action: "run" | "check") => Promise<TriggerResult>,
  deps: { file: string; surface: DispatchSurface; deliver: () => Promise<void>; now?: () => Date },
): SproutTrigger {
  return async (name, action, origin: SproutOrigin) => {
    const t = await trigger(name, action);
    if (t.status !== "started") return t;
    let id: string;
    try {
      id = openDispatch(deps.file, {
        surface: deps.surface, routine: name,
        ...(origin.channel ? { conversation: origin.channel } : {}), ...(origin.actor ? { actor: origin.actor } : {}),
      }, randomUUID, deps.now);
    } catch (err) {
      console.error(`bean: recording the dispatch of "${name}" failed — no finish reply`, err);
      return t;
    }
    void t.done
      .then((o) => {
        // One run's brief only: a drain with several runs never mixes them.
        const only = o.perRun.length === 1 ? o.perRun[0] : undefined;
        closeDispatch(deps.file, id, {
          status: o.status, runIds: o.perRun.flatMap((r) => (r.id ? [r.id] : [])), ...(only?.brief ? { brief: only.brief } : {}),
        }, deps.now);
        return deps.deliver();
      })
      .catch((err: unknown) => console.error(`bean: finishing the dispatch of "${name}" failed`, err));
    return t;
  };
}
