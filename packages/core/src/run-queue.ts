import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "./config.js";

/** Cross-process "is this project already claimed?" reservation (~/.bean/runs/<id>.json), one
 * file per active run — mirrors outbox.ts's file-per-message convention so writes never race a
 * shared file. Deliberately NOT a full run record: reporting (what happened, to whom) is handled
 * by the outbox instead — see .memory/project-durable-run-queue.md.
 *
 * Uses sync fs (tiny local JSON files, not a hot path) rather than fs/promises like the rest of
 * this package: release is called fire-and-forget from inside a synchronous settle callback
 * (RunRegistry/delegate-tasks), and an unawaited async write can still be on disk when the very
 * next start() call (same tick, same process) checks for a stale reservation — sync makes that
 * release atomic with the callback that triggers it, so no such race is possible. */
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

/** Reserve `projectPath` for the calling process, or return undefined if another live process
 * already holds it. A reservation left by a process that has since died (crash/kill -9/OOM —
 * none of which run our graceful-shutdown cleanup) is detected via pid liveness and reclaimed:
 * this is the whole crash-recovery story, no heartbeats/TTLs needed. */
export async function reserveRun(
  dir: string,
  projectPath: string,
  pid: number,
  newId: () => string,
): Promise<RunReservation | undefined> {
  const runsPath = runsDir(dir);
  let entries: string[];
  try {
    entries = readdirSync(runsPath);
  } catch {
    entries = [];
  }
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const path = join(runsPath, file);
    const existing = readReservation(path);
    if (!existing) {
      rmSync(path, { force: true }); // malformed — sweep, same policy as outbox/routine loaders
      continue;
    }
    if (existing.projectPath !== projectPath) continue;
    if (isLive(existing.pid)) return undefined; // busy — a live process holds this project
    rmSync(path, { force: true }); // stale — owning process is dead, reclaim
  }
  const reservation: RunReservation = { id: newId(), projectPath, pid, createdAt: new Date().toISOString() };
  mkdirSync(runsPath, { recursive: true });
  writeFileSync(join(runsPath, `${reservation.id}.json`), JSON.stringify(reservation, null, 2) + "\n", "utf8");
  return reservation;
}

export async function releaseRun(dir: string, id: string): Promise<void> {
  rmSync(join(runsDir(dir), `${id}.json`), { force: true });
}
