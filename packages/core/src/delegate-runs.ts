import { existsSync } from "node:fs";
import { openDb } from "./db.js";
import type { CliName } from "./launcher.js";

/** One delegate session as recorded in bean.db's append-only `delegate_runs` table, so the user
 * can reopen the CLI's own session by hand later (see .memory/project-delegate-session-receipts.md). */
export interface DelegateRunRow {
  surface: "desktop" | "discord" | "teams" | "routine";
  cli: CliName;
  sessionId: string;
  projectPath: string;
  /** The user's instruction, never the composed skill prompt. */
  instruction: string;
}

// Session ids are untrusted subprocess output: the leading alphanumeric rules out option-like
// values (`--help`) that would turn a copied resume command into something else.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/** The interactive resume form for each CLI. Only call with an id that passed isValidSessionId. */
export function resumeCommand(cli: CliName, sessionId: string): string {
  return cli === "claude" ? `claude --resume ${sessionId}`
    : cli === "codex" ? `codex resume ${sessionId}`
    : `opencode -s ${sessionId}`;
}

/** Records one row; returns false (logged without the row's values) on an invalid id or a failed
 * write. Never throws — a bookkeeping failure must not fail or alter the run itself. */
export function recordDelegateSession(file: string, row: DelegateRunRow, now: () => Date = () => new Date()): boolean {
  if (!isValidSessionId(row.sessionId)) {
    console.warn(`bean: ignored an invalid ${row.cli} session id from a ${row.surface} delegate run`);
    return false;
  }
  try {
    openDb(file)
      .prepare("INSERT INTO delegate_runs (started_at, surface, cli, session_id, project_path, instruction) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now().toISOString(), row.surface, row.cli, row.sessionId, row.projectPath, row.instruction);
    return true;
  } catch (err) {
    console.warn(`bean: couldn't record a ${row.surface} delegate session:`, err instanceof Error ? err.name : "error");
    return false;
  }
}

/** A delegate run that can be continued as a live session, or the one-sentence reason it can't. */
export type ResumableRun = { run: DelegateRunRow } | { refusal: string };

/** Looks up the newest `delegate_runs` row for `sessionId` and checks it can continue live: a
 * Claude session Bean recorded outside the desktop chat whose project folder still exists. The
 * project path always comes from this row, never from the caller. */
export function findDelegateRun(file: string, sessionId: string, exists: (path: string) => boolean = existsSync): ResumableRun {
  if (!isValidSessionId(sessionId)) return { refusal: "Copy the id from the `claude --resume …` line." };
  const row = openDb(file)
    .prepare("SELECT surface, cli, session_id, project_path, instruction FROM delegate_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { surface: DelegateRunRow["surface"]; cli: CliName; session_id: string; project_path: string; instruction: string } | undefined;
  if (!row) return { refusal: "I have no record of that run." };
  if (row.cli !== "claude") return { refusal: "Only Claude sessions continue live for now — resume it from a terminal." };
  if (row.surface === "desktop") return { refusal: "That run started in Bean's desktop chat — continue it there." };
  if (!exists(row.project_path)) return { refusal: "That project folder no longer exists on this Mac." };
  return { run: { surface: row.surface, cli: row.cli, sessionId: row.session_id, projectPath: row.project_path, instruction: row.instruction } };
}
