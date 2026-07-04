export function createDevProcessManager() {
  const children = new Set();
  const track = (child) => {
    children.add(child);
    child.once?.("exit", () => children.delete(child));
    return child;
  };
  // Best-effort reap when the dev orchestrator itself exits (e.g. an unhandled error).
  // The common Ctrl+C path is NOT handled here: children are spawned WITHOUT `detached`,
  // so they share our process group and the terminal's SIGINT reaches every one directly.
  // See safety-dev-children-not-detached.md — detaching them shields them from Ctrl+C and
  // orphans the Electron app when this handler doesn't run (pnpm kills us first).
  const killAll = () => {
    for (const child of children) {
      if (child.exitCode !== null || child.killed) continue;
      child.kill(); // SIGTERM
    }
  };
  return { track, killAll };
}
