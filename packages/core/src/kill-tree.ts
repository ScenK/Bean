import { execFileSync } from "node:child_process";

// opencode and codex run each tool command in its OWN process group, and opencode reaps it on
// neither SIGTERM nor SIGINT — so a group kill on the CLI orphans the tool (a build, a `git push`
// …) in the project folder, reparented to PID 1. These helpers widen a stop to every
// descendant's group. Children must be spawned `detached` (own session), so no descendant can
// share the host's group.

const listProcs = (): string => execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });

/** `pid`'s own group plus every descendant's pgid, from one synchronous `ps` snapshot (safe in a
 * quit sweep). Take it right before the first signal: the CLI spawns tools mid-turn, and once it
 * dies they're reparented to PID 1, where a later walk can't find them. A failed `ps` degrades to
 * `[pid]` (today's plain group kill).
 * ponytail: a tool forked between the snapshot and the signal escapes — the window is one ps call. */
export function treeGroups(pid: number, ps: () => string = listProcs): number[] {
  const kids = new Map<number, [number, number][]>();
  try {
    for (const line of ps().split("\n")) {
      const [p, pp, pg] = line.trim().split(/\s+/).map(Number);
      if (p === undefined || pp === undefined || pg === undefined || p === pp || ![p, pp, pg].every(Number.isInteger)) continue;
      kids.set(pp, [...(kids.get(pp) ?? []), [p, pg]]);
    }
  } catch {
    return [pid];
  }
  const groups = new Set([pid]);
  const queue = [pid];
  for (let i = 0; i < queue.length; i++) {
    for (const [p, pg] of kids.get(queue[i]!) ?? []) {
      if (pg > 1) groups.add(pg);
      queue.push(p);
    }
  }
  return [...groups];
}

export function signalGroups(groups: number[], signal: NodeJS.Signals): void {
  for (const g of groups) {
    try {
      process.kill(-g, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Snapshot `pid`'s tree, signal every group, and return them — keep the result for the
 * SIGKILL escalation (see escalateKill). */
export function killTree(pid: number, signal: NodeJS.Signals, ps?: () => string): number[] {
  const groups = treeGroups(pid, ps);
  signalGroups(groups, signal);
  return groups;
}

// Saved groups whose SIGKILL escalation hasn't fired yet. A quit/shutdown inside the grace period
// would never see the timer fire, so killPendingGroups() sweeps them.
const pending = new Set<number[]>();

/** SIGKILL `groups` after `ms`. Deliberately NOT tied to the parent's close: opencode exits at
 * once on the soft signal while a tool that ignores it lives on, so callers must not cancel it
 * from a close/settle handler. */
export function escalateKill(groups: number[], ms = 5_000): void {
  pending.add(groups);
  setTimeout(() => {
    if (!pending.delete(groups)) return; // already swept
    signalGroups(groups, "SIGKILL");
  }, ms);
}

/** SIGKILL every pending escalation now. For quit/shutdown sweeps only. */
export function killPendingGroups(): void {
  for (const groups of pending) signalGroups(groups, "SIGKILL");
  pending.clear();
}
