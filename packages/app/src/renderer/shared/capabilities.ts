import { useEffect, useState } from "preact/hooks";
import type { Capability, Handshake } from "@bean/host";
import { useCoreStatus } from "./core-status.js";

// What the attached core's machine can do for this shell (#812), from its handshake — fetched once per
// window, again after a reconnect if it hadn't answered. A remote core never offers a host-bound control
// here (the remote adapter refuses every one: no pty, path opens or Terminal hand-off across machines);
// until a local core answers, it is assumed to have them all.
let handshake: Handshake | undefined;
let loading = false;
const subs = new Set<() => void>();
function load(): void {
  if (handshake || loading || typeof window.bean.handshake !== "function") return;
  loading = true;
  window.bean.handshake().then(
    (h) => { handshake = h; for (const fn of subs) fn(); },
    () => {},
  ).finally(() => { loading = false; });
}

export interface Capabilities {
  has: (c: Capability) => boolean;
  /** The core machine's `process.platform`, once its handshake answered. */
  platform: string | undefined;
  /** The remote core's host (`user@host`); undefined for a local core. */
  host: string | undefined;
}

export function useCapabilities(): Capabilities {
  const core = useCoreStatus();
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = (): void => rerender((n) => n + 1);
    subs.add(fn);
    return () => { subs.delete(fn); };
  }, []);
  const state = core.kind === "remote" ? core.state : core.kind;
  useEffect(load, [state]);
  const remote = core.kind === "remote";
  return {
    has: (c) => !remote && (handshake ? handshake.capabilities.includes(c) : core.kind === "local"),
    platform: handshake?.platform,
    host: remote ? core.host : undefined,
  };
}

/** Copies a path to the clipboard — what a remote core's file paths get instead of an open. */
export const copyPath = (path: string): Promise<void> => navigator.clipboard.writeText(path);
