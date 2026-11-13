// packages/core/src/scheduler-lease.ts
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { openDb } from "./db.js";

/** Who holds (or last held) the lease: `label` is human-readable, for notices. */
export interface LeaseHolder { holder: string; label: string; expires: number }

export const SCHEDULER_LEASE_TTL_MS = 90_000;
export const SCHEDULER_LEASE_HEARTBEAT_MS = 30_000;

/** Atomic claim/renew of the `scheduler` lease — one statement, so two processes can't both win.
 * Succeeds when the row is free, expired (holder crashed or gone), or already ours (renewal).
 * Returns undefined on success, else the current holder. */
export function claimSchedulerLease(file: string, holder: string, label: string, nowMs: number, ttlMs: number): LeaseHolder | undefined {
  const db = openDb(file);
  const res = db.prepare(
    `INSERT INTO leases (name, holder, label, expires) VALUES ('scheduler', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, label = excluded.label, expires = excluded.expires
     WHERE leases.expires < ? OR leases.holder = ?`,
  ).run(holder, label, nowMs + ttlMs, nowMs, holder);
  if (Number(res.changes) > 0) return undefined;
  return db.prepare("SELECT holder, label, expires FROM leases WHERE name = 'scheduler'").get() as unknown as LeaseHolder;
}

/** Drops the lease only if `holder` still has it. */
export function releaseSchedulerLease(file: string, holder: string): void {
  openDb(file).prepare("DELETE FROM leases WHERE name = 'scheduler' AND holder = ?").run(holder);
}

export interface HoldSchedulerLeaseOpts {
  file: string;
  /** Who this process is, e.g. "desktop app" — shown to the process that's refused. pid + host are appended. */
  label: string;
  /** Fired once, when this process first holds the lease (synchronously inside the call when it's free). */
  onAcquired: () => void;
  /** Fired once, on the first failed claim. Keeps retrying every heartbeat (standby) until stop(). */
  onBlocked: (by: LeaseHolder) => void;
  /** A renewal found someone else holding it (we stalled past the TTL and were taken over). Terminal. */
  onLost: (by: LeaseHolder) => void;
  ttlMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

/** Takes the scheduler lease and heartbeats it. A refused process stands by and takes over once
 * the holder's heartbeat expires (crash) or it releases (clean quit). A sleeping Mac's own expired
 * lease is just renewed on wake, unless another process took it meanwhile (→ onLost). */
export function holdSchedulerLease(opts: HoldSchedulerLeaseOpts): { stop: () => void } {
  const ttl = opts.ttlMs ?? SCHEDULER_LEASE_TTL_MS;
  const now = opts.now ?? Date.now;
  const holder = randomUUID();
  const label = `${opts.label} (pid ${process.pid} on ${hostname()})`;
  let state: "waiting" | "held" | "done" = "waiting";
  let blocked = false;
  const beat = (): void => {
    let by: LeaseHolder | undefined;
    try {
      by = claimSchedulerLease(opts.file, holder, label, now(), ttl);
    } catch (err) {
      // A busy/locked db: try again next beat. A holder that can't renew for a full TTL loses it.
      console.error("bean: scheduler lease heartbeat failed", err);
      return;
    }
    if (state === "waiting") {
      if (!by) { state = "held"; opts.onAcquired(); }
      else if (!blocked) { blocked = true; opts.onBlocked(by); }
    } else if (state === "held" && by) {
      state = "done";
      clearInterval(timer);
      opts.onLost(by);
    }
  };
  const timer = setInterval(beat, opts.heartbeatMs ?? SCHEDULER_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  const stop = (): void => {
    clearInterval(timer);
    if (state === "held") {
      // Best-effort: an unreleased lease just expires after the TTL.
      try { releaseSchedulerLease(opts.file, holder); } catch (err) { console.error("bean: scheduler lease release failed", err); }
    }
    state = "done";
  };
  beat();
  return { stop };
}
