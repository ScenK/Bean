import { useEffect, useState } from "preact/hooks";
import type { CoreStatus } from "../../channels.js";

// The shell's attachment state (#811), shared by every component in a window: pulled once, then pushed.
// The preload's bridges can't unsubscribe, so one listener per window feeds every hook.
let current: CoreStatus = { kind: "local" };
const subs = new Set<(s: CoreStatus) => void>();
let started = false;
const set = (s: CoreStatus | undefined): void => {
  if (typeof s !== "object" || s === null) return; // a window with no answer stays as it was
  current = s;
  for (const fn of subs) fn(s);
};
function start(): void {
  if (started) return;
  started = true;
  window.bean.onCoreStatus(set);
  window.bean.coreStatus().then(set, () => {});
}

export function useCoreStatus(): CoreStatus {
  const [s, setS] = useState(current);
  useEffect(() => {
    start();
    setS(current);
    subs.add(setS);
    return () => { subs.delete(setS); };
  }, []);
  return s;
}

/** A remote core that can't take a turn right now: the composer is read-only. */
export const coreOffline = (s: CoreStatus): boolean => s.kind === "remote" && s.state !== "attached";
