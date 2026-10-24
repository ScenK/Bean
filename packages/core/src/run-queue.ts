import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runsDir } from "./config.js";

/** Cross-process record of every tracked delegate run (~/.bean/runs/<runId>.json), one file per
 * run keyed by a server-generated run id — mirrors outbox.ts's file-per-message convention so
 * writes never race a shared file. Not a lock: runs on one project overlap freely (each agent
 * isolates itself in its own worktree). The records exist for crash cleanup — the headless boot
 * kills what they name, the desktop boot sweeps the dead ones. Deliberately NOT a full run record:
 * reporting is handled by the outbox instead — see .memory/project-durable-run-queue.md.
 *
 * Fully synchronous (node:fs, not fs/promises): called from settle callbacks and Electron's
 * before-quit / a bare process.on("SIGTERM") — none of which reliably support awaiting real
 * async work — so every write here must be guaranteed done by the time the call returns. */
export interface TrackedRun {
  id: string;
  projectPath: string;
  pid: number;
  createdAt: string; // ISO
}

function isLive(pid: number): boolean {
  try {
    // Signal 0: no-op, just probes whether the process exists (throws ESRCH if not).
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Run ids are server-generated (randomUUID / a surface's newId), never user text; basename()
// still keeps a malformed one inside runs/.
function runFile(dir: string, runId: string): string {
  return join(runsDir(dir), `${basename(runId)}.json`);
}

function readRun(path: string): TrackedRun | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TrackedRun>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.projectPath === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as TrackedRun;
    }
  } catch {
    // malformed — treated as absent below
  }
  return undefined;
}

// Temp + rename: a plain rewrite truncates first, and another process's sweep reading the empty
// file would delete a live record. The `.tmp` name never matches runFiles' `.json` filter.
function writeRun(path: string, run: TrackedRun): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Record a run against `pid` (the owning process until its child spawns — see updateRunPid).
 * Never refuses: any number of runs may share a project. */
export function recordRun(dir: string, runId: string, projectPath: string, pid: number): void {
  mkdirSync(runsDir(dir), { recursive: true });
  writeRun(runFile(dir, runId), { id: runId, projectPath, pid, createdAt: new Date().toISOString() });
}

/** Point a run's record at its delegate CHILD once spawned, so an interrupt can leave the record
 * in place (the child may outlive this process) and boot cleanup targets *that child*, not the
 * exited owner. No-op if the record is already gone (settled faster than this update landed). */
export function updateRunPid(dir: string, runId: string, pid: number): void {
  const path = runFile(dir, runId);
  const existing = readRun(path);
  if (!existing) return;
  writeRun(path, { ...existing, pid });
}

export function releaseRun(dir: string, runId: string): void {
  rmSync(runFile(dir, runId), { force: true });
}

function runFiles(dir: string): string[] {
  try { return readdirSync(runsDir(dir)).filter((f) => f.endsWith(".json")); } catch { return []; }
}

/** Desktop boot: delete records whose pid is dead or that don't parse. Legacy per-project hash
 * files share the record shape, so they go the same way. Never kills: the bots share runs/, and a
 * live record may be their running child. Returns how many were deleted. */
export function sweepDeadRuns(dir: string): number {
  let swept = 0;
  for (const f of runFiles(dir)) {
    const path = join(runsDir(dir), f);
    const r = readRun(path);
    if (r && isLive(r.pid)) continue;
    rmSync(path, { force: true });
    swept++;
  }
  return swept;
}

/** Headless boot only (the bot owns ~/.bean alone): kill each recorded run's process group, then
 * delete every record (legacy per-project hash files included). After a container restart pids
 * start low again, so a stale record's pid can match an unrelated live process. Returns the
 * cleared project paths. Skips this process and pid ≤ 1. */
export function clearReservations(dir: string, kill: (pid: number) => void = (pid) => process.kill(-pid, "SIGKILL")): string[] {
  const cleared: string[] = [];
  for (const f of runFiles(dir)) {
    const path = join(runsDir(dir), f);
    const r = readRun(path);
    if (r && r.pid > 1 && r.pid !== process.pid) {
      try { kill(r.pid); } catch { /* already gone, or not a group leader */ }
    }
    rmSync(path, { force: true });
    cleared.push(r?.projectPath ?? f);
  }
  return cleared;
}

const MAX_DISPLAY_INSTRUCTION = 140;

/** The message an interrupted run leaves for whichever surface requested it. `full` keeps the
 * complete instruction — it's what a later chat/conversation turn needs so "retry" actually has
 * something to act on — while `display` is a short, human-readable version for the channel/chat
 * bubble itself (the full instruction can be a multi-paragraph composed prompt, not fit for a
 * one-line notice or a status pill). */
export function interruptedRunNotice(projectPath: string, instruction: string): { full: string; display: string } {
  const full = `Run on ${projectPath} ("${instruction}") was interrupted when Bean closed. Ask me again to retry.`;
  const projectName = basename(projectPath) || projectPath;
  const shortInstruction = instruction.length > MAX_DISPLAY_INSTRUCTION
    ? `${instruction.slice(0, MAX_DISPLAY_INSTRUCTION).trimEnd()}…`
    : instruction;
  const display = `⚠️ A run on **${projectName}** ("${shortInstruction}") was interrupted when Bean closed. Say "retry" and I'll pick it back up.`;
  return { full, display };
}
