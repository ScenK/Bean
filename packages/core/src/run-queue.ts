import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runsDir } from "./config.js";

/** Cross-process "is this project already claimed?" reservation (~/.bean/runs/<hash>.json), one
 * deterministically-named file per project path — mirrors outbox.ts's file-per-message
 * convention so writes never race a shared file. Deliberately NOT a full run record: reporting
 * (what happened, to whom) is handled by the outbox instead — see
 * .memory/project-durable-run-queue.md.
 *
 * Fully synchronous (node:fs, not fs/promises): called from settle callbacks and Electron's
 * before-quit / a bare process.on("SIGTERM") — none of which reliably support awaiting real
 * async work — so every write here must be guaranteed done by the time the call returns. */
export interface RunReservation {
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

// Deterministic, filesystem-safe name derived from the project path itself: every process
// asking about the same project computes the same filename, so the file's own existence (via
// an atomic O_EXCL create below) *is* the cross-process lock. A directory-scan-then-write-a-
// new-unique-file scheme has a TOCTOU window — two processes can both see "no reservation yet"
// and both write, defeating the whole point of this module.
function reservationFile(dir: string, projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 32);
  return join(runsDir(dir), `${hash}.json`);
}

function readReservation(path: string): RunReservation | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunReservation>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.projectPath === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as RunReservation;
    }
  } catch {
    // malformed — treated as absent below
  }
  return undefined;
}

// `"wx"` = O_CREAT | O_EXCL: atomically fails with EEXIST if the file already exists, at the
// kernel level — no separate check-then-write race at the JS level, unlike a plain existsSync
// check would have.
function writeReservation(path: string, reservation: RunReservation, flag: "wx" | "w"): boolean {
  try {
    writeFileSync(path, JSON.stringify(reservation, null, 2) + "\n", { encoding: "utf8", flag });
    return true;
  } catch (err) {
    if (flag === "wx" && (err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Reserve `projectPath` for the calling process, or return undefined if another live process
 * already holds it. A reservation left by a process that has since died (crash/kill -9/OOM —
 * none of which run our graceful-shutdown cleanup — or a graceful interrupt that deliberately
 * leaves the reservation in place, see updateReservationPid below) is detected via pid liveness
 * and reclaimed: this is the whole crash-recovery story, no heartbeats/TTLs needed. */
export function reserveRun(dir: string, projectPath: string, pid: number, newId: () => string): RunReservation | undefined {
  mkdirSync(runsDir(dir), { recursive: true });
  const path = reservationFile(dir, projectPath);
  const reservation: RunReservation = { id: newId(), projectPath, pid, createdAt: new Date().toISOString() };
  if (writeReservation(path, reservation, "wx")) return reservation;

  // Already reserved. Busy only if verifiably alive — malformed/unreadable is treated the same
  // as "can't confirm it's live", same policy as any other malformed-file sweep in this codebase.
  const existing = readReservation(path);
  if (existing && isLive(existing.pid)) return undefined;
  rmSync(path, { force: true });
  return writeReservation(path, reservation, "wx") ? reservation : undefined;
}

/** Update a live reservation's tracked pid — called once a delegate's actual child process has
 * spawned. The reservation is created against the *owning* process's pid before the child
 * exists (nothing else to track yet); switching it to the child's own pid means an interrupt
 * (see releaseRun's caller doc comments in RunRegistry/delegate-tasks) can leave the reservation
 * in place instead of releasing it blind, and the next reserveRun's liveness check will
 * correctly track whether *that child* — not the about-to-exit parent — is still running. No-op
 * if the reservation is already gone (settled faster than this update landed). */
export function updateReservationPid(dir: string, projectPath: string, pid: number): void {
  const path = reservationFile(dir, projectPath);
  const existing = readReservation(path);
  if (!existing) return;
  writeReservation(path, { ...existing, pid }, "w");
}

export function releaseRun(dir: string, projectPath: string): void {
  rmSync(reservationFile(dir, projectPath), { force: true });
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
