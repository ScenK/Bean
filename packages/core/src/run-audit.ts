import { dbFile } from "./config.js";
import { openDb } from "./db.js";
import { liveRuns } from "./run-queue.js";

/** How a chatops run started: a confirmed card, a cardless grant continuation, Bean's automatic
 * follow-up, or a live session. */
export type AuditTrigger = "card" | "continuation" | "follow_up" | "live";
export type AuditOutcome = "running" | "done" | "failed" | "cancelled" | "refused" | "interrupted";
/** A platform id (authenticated adapter field) plus a display-name snapshot. */
export interface AuditPerson { id?: string; name?: string }

/** One `run_audit` row as written at start. Only the instruction that ran (and the card's original
 * when the confirmer edited it) — never a composed prompt, skill body, memories, output or error text. */
export interface AuditStart {
  runId: string;
  surface: "discord" | "teams";
  conversationId: string;
  channelName?: string;
  trigger: AuditTrigger;
  askedBy?: AuditPerson;
  confirmedBy?: AuditPerson;
  /** continuation / follow_up: the original grant confirmer's platform id — never a re-confirmation. */
  authorityId?: string;
  projectPath: string;
  skill?: string;
  cli: string;
  model?: string;
  instruction: string;
  instructionProposed?: string;
}

export interface AuditRow {
  run_id: string; started_at: string; ended_at: string | null; duration_ms: number | null;
  surface: string; conversation_id: string; channel_name: string | null; trigger: AuditTrigger;
  asked_by_id: string | null; asked_by_name: string | null; confirmed_by_id: string | null; confirmed_by_name: string | null;
  authority_id: string | null; cancelled_by_id: string | null; cancelled_by_name: string | null;
  project_path: string; skill: string | null; cli: string; model: string | null;
  instruction: string; instruction_proposed: string | null; session_id: string | null; outcome: AuditOutcome;
}

// Every write is fail-open: an audit failure logs a data-free warning and never alters the run.
function write(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`bean: couldn't write the run audit (${what}):`, err instanceof Error ? err.name : "error");
  }
}

function insert(file: string, row: AuditStart, outcome: "running" | "refused", now: Date): void {
  const at = now.toISOString();
  openDb(file).prepare(
    `INSERT OR IGNORE INTO run_audit (run_id, started_at, ended_at, duration_ms, surface, conversation_id, channel_name, trigger,
       asked_by_id, asked_by_name, confirmed_by_id, confirmed_by_name, authority_id, project_path, skill, cli, model,
       instruction, instruction_proposed, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.runId, at, outcome === "refused" ? at : null, outcome === "refused" ? 0 : null, row.surface, row.conversationId,
    row.channelName ?? null, row.trigger, row.askedBy?.id ?? null, row.askedBy?.name ?? null,
    row.confirmedBy?.id ?? null, row.confirmedBy?.name ?? null, row.authorityId ?? null, row.projectPath, row.skill ?? null,
    row.cli, row.model ?? null, row.instruction, row.instructionProposed ?? null, outcome,
  );
}

/** A run about to spawn: `outcome = 'running'`. */
export function recordAuditStart(file: string, row: AuditStart, now: Date = new Date()): void {
  write("start", () => insert(file, row, "running", now));
}

/** A run refused before it spawned (missing skill, no CLI, strict-resume refusal). */
export function recordAuditRefused(file: string, row: AuditStart, now: Date = new Date()): void {
  write("refusal", () => insert(file, row, "refused", now));
}

/** Backfills the CLI session id once the session reports it. */
export function recordAuditSession(file: string, runId: string, sessionId: string): void {
  write("session", () => {
    openDb(file).prepare("UPDATE run_audit SET session_id = ? WHERE run_id = ?").run(sessionId, runId);
  });
}

/** Settles a still-running row once; a late or repeated settle is a no-op. */
export function recordAuditEnd(
  file: string, runId: string, outcome: "done" | "failed" | "cancelled" | "interrupted",
  cancelledBy?: AuditPerson, now: Date = new Date(),
): void {
  write("end", () => {
    const at = now.toISOString();
    openDb(file).prepare(
      `UPDATE run_audit SET ended_at = ?, outcome = ?, cancelled_by_id = ?, cancelled_by_name = ?,
         duration_ms = MAX(0, CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER))
       WHERE run_id = ? AND outcome = 'running'`,
    ).run(at, outcome, cancelledBy?.id ?? null, cancelledBy?.name ?? null, at, runId);
  });
}

/** Flips these runs' still-running rows to `interrupted` (their process is dying or died). */
export function markAuditInterrupted(file: string, runIds: string[], now: Date = new Date()): void {
  for (const id of runIds) recordAuditEnd(file, id, "interrupted", undefined, now);
}

/** Boot (after `sweepDeadRuns`): flips `running` rows whose run record is missing or dead — their
 * process crashed — to `interrupted`. The rows are read before the live records: a run writes its
 * record before its row, so a row seen here whose run is alive always finds its record. */
export function reconcileAuditRuns(dir: string, now: Date = new Date()): void {
  write("reconcile", () => {
    const file = dbFile(dir);
    const running = (openDb(file).prepare("SELECT run_id FROM run_audit WHERE outcome = 'running'").all() as { run_id: string }[])
      .map((r) => r.run_id);
    if (running.length === 0) return;
    const live = new Set(liveRuns(dir).map((r) => r.id));
    markAuditInterrupted(file, running.filter((id) => !live.has(id)), now);
  });
}

export interface AuditQuery {
  /** ISO timestamp: rows that started at or after it. */
  since?: string;
  limit?: number;
  /** Substring of the project path. */
  project?: string;
  /** A platform id in any actor column. */
  actor?: string;
}

/** Newest first; [] when the read fails. */
export function queryRunAudit(file: string, q: AuditQuery = {}): AuditRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.since) { where.push("started_at >= ?"); args.push(q.since); }
  if (q.project) { where.push("instr(project_path, ?) > 0"); args.push(q.project); }
  if (q.actor) {
    where.push("? IN (asked_by_id, confirmed_by_id, authority_id, cancelled_by_id)");
    args.push(q.actor);
  }
  try {
    return openDb(file).prepare(
      `SELECT * FROM run_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
    ).all(...args, Math.max(1, Math.floor(q.limit ?? 50))) as unknown as AuditRow[];
  } catch {
    return [];
  }
}
