/** Minimal timer handle: `setInterval` returns `number` under the DOM lib and `Timeout` under
 * Node's, and core compiles with both — this sidesteps that union. */
export interface TimerHandle { unref?: () => void }

export interface OrphanGuardDeps {
  /** Current parent pid; defaults to the real process. */
  getPpid?: () => number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (t: TimerHandle) => void;
  /** Poll period; the watchdog only compares one integer, so this is cheap. */
  pollMs?: number;
}

/** Exits when the process that spawned us goes away.
 *
 * A chatops server outlives its parent otherwise: quitting the desktop app (or force-quitting
 * / crashing it) leaves the spawned server running, reparented to launchd, still bound to its
 * port and still answering webhooks with whatever build it booted with. Three such orphans —
 * from three different days, the oldest owning the port — once made a shipped behavior change
 * look like it had never landed. The app's stopAll() covers the clean-quit path; this covers
 * every other way the parent can die.
 *
 * Returns a cancel function. The interval is unref'd so it never keeps the server alive by
 * itself. */
export function exitWhenOrphaned(deps: OrphanGuardDeps = {}): () => void {
  const {
    getPpid = () => process.ppid,
    exit = (code) => process.exit(code),
    log = (m) => console.error(m),
    setIntervalFn = (fn, ms) => setInterval(fn, ms) as unknown as TimerHandle,
    clearIntervalFn = (t) => clearInterval(t as unknown as ReturnType<typeof setInterval>),
    pollMs = 5_000,
  } = deps;

  const original = getPpid();
  let fired = false;
  const timer = setIntervalFn(() => {
    if (fired || getPpid() === original) return;
    fired = true;
    clearIntervalFn(timer);
    // Exit 0: being orphaned is an expected shutdown, not a crash to report.
    log(`parent process ${original} is gone — shutting down so a stale server can't keep serving.`);
    exit(0);
  }, pollMs);
  timer.unref?.();

  return () => clearIntervalFn(timer);
}
