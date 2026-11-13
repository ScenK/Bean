import type { Readable, Writable } from "node:stream";
import {
  checkHandshake, CONTRACT_VERSION, encodeFrame, frameReader, REMOTE_OPS, type Handshake, type MountPushKind,
} from "@bean/host";
import { IPC, type CoreStatus } from "./channels.js";
import { CHANNEL_CONTRACT, guardIpc, type IpcLike } from "./channel-contract.js";

// The shell side of a remote attach (#811): one `ssh <host> bean-core attach` child carries every window's
// calls and the core's pushes as length-prefixed JSON frames (@bean/host remote.ts). The core is the
// gate (default-deny REMOTE_OPS, generation checks); this side only keeps the connection: attach →
// resume past its acks → heartbeat every 10 s. A lost connection retries with backoff (the core keeps
// the chats' work for its 30-minute grace and replays what was missed); a takeover or a contract
// version mismatch stops for good until the user acts.

/** Same beat the core's watchdog expects (HEARTBEAT_TIMEOUT_MS is 30 s). */
export const HEARTBEAT_MS = 10_000;
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];
/** How long after a reattach a delegate start whose reply was lost waits for the core's `started`. */
export const ORPHAN_START_MS = 30_000;

export interface SshChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  kill(): unknown;
}

export interface RemoteCoreDeps {
  /** `user@host` (+ container) for the badge and messages. */
  label: string;
  /** Spawns the ssh child (fixed argv: core-store.ts `sshArgs`). */
  spawn: () => SshChild;
  /** This install's persistent shell id (`@bean/host` shellClientId). */
  shellId: string;
  /** Shown while ssh can't attach unattended (core-store.ts `oneTimeCommand`). */
  setupCommand: string;
  onPush: (mountId: string, kind: MountPushKind, payload: unknown) => void;
  onStatus: (status: CoreStatus) => void;
  /** Delegates or agent sessions this shell started are running on the core. */
  onWorking: (working: boolean) => void;
  /** Reconnect backoff (tests shorten it). */
  retryMs?: readonly number[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lastLine = (s: string): string | undefined => s.trim().split("\n").filter(Boolean).pop()?.slice(0, 300);

export function createRemoteCore(deps: RemoteCoreDeps) {
  type State = Extract<CoreStatus, { kind: "remote" }>["state"];
  let state: State = "connecting";
  let message: string | undefined;
  let child: SshChild | undefined;
  let handshake: Handshake | undefined;
  let generation: number | undefined;
  let everAttached = false;
  let stopped = false;
  let failures = 0;
  let beat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  // A delegate start, as its `started` event will name it.
  type Start = { mountId: string; projectPath: string; instruction: string };
  type Settle = { resolve: (v: unknown) => void; reject: (e: Error) => void };
  const pending = new Map<number, Settle & { start?: Start }>();
  // The renderer learns a delegate's task id only from delegateStart's reply. A drop can lose that reply
  // after the core started the task, so an in-flight start isn't failed: it waits ("orphan") for the
  // core's `started` event for the same chat, project and instruction — live before the drop, or in the
  // resume replay — and resolves with its task id. Never re-sent: requests that start a process aren't.
  const orphans: Array<Start & Settle> = [];
  /** `started` events whose start reply hasn't arrived (yet): what an orphan matches against. */
  const unclaimed: Array<Start & { taskId: string }> = [];
  let orphanTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last seq applied per chat: sent with each heartbeat and on resume, so the core replays only the rest. */
  const acks: Record<string, number> = {};
  /** Work this shell started that the core reports running: `d:<taskId>` / `l:<sessionId>`. */
  const running = new Set<string>();

  const status = (): CoreStatus => ({
    kind: "remote", host: deps.label, state,
    ...(message ? { message } : {}),
    // The setup hint only while ssh has never attached: after that, a drop is the network, not the keys.
    ...(!everAttached && state === "reconnecting" ? { command: deps.setupCommand } : {}),
  });
  const setState = (next: State, msg?: string): void => {
    state = next;
    message = msg;
    deps.onStatus(status());
  };
  const setWorking = (key: string, on: boolean): void => {
    const was = running.size > 0;
    if (on) running.add(key); else running.delete(key);
    if (was !== running.size > 0) deps.onWorking(running.size > 0);
  };
  const write = (c: SshChild, m: unknown): boolean => {
    const frame = encodeFrame(m);
    if (!frame) return false;
    c.stdin.write(frame);
    return true;
  };
  const sameStart = (a: Start, b: Start): boolean =>
    a.mountId === b.mountId && a.projectPath === b.projectPath && a.instruction === b.instruction;
  const startOf = (op: string, args: unknown[]): Start | undefined => {
    const [req, mountId] = args;
    if (op !== "delegateStart" || !isObj(req) || typeof mountId !== "string") return undefined;
    const { projectPath, instruction } = req;
    return typeof projectPath === "string" && typeof instruction === "string" ? { mountId, projectPath, instruction } : undefined;
  };
  /** Pairs orphans with `started` events seen for them, oldest first. */
  const matchOrphans = (): void => {
    for (let i = 0; i < orphans.length;) {
      const o = orphans[i]!;
      const j = unclaimed.findIndex((u) => sameStart(u, o));
      if (j < 0) { i++; continue; }
      const [u] = unclaimed.splice(j, 1);
      orphans.splice(i, 1);
      o.resolve(u!.taskId);
    }
  };
  const failOrphans = (why: string): void => {
    clearTimeout(orphanTimer);
    for (const o of orphans.splice(0)) o.reject(new Error(why));
  };
  const failPending = (why: string): void => {
    for (const p of pending.values()) {
      if (p.start) orphans.push({ ...p.start, resolve: p.resolve, reject: p.reject });
      else p.reject(new Error(why));
    }
    pending.clear();
    matchOrphans();
  };
  /** Ends the current child: its late frames and exit are ignored from here on. */
  const drop = (): void => {
    clearInterval(beat);
    beat = undefined;
    generation = undefined;
    clearTimeout(orphanTimer);
    const c = child;
    child = undefined;
    if (c) { c.stdin.end(); c.kill(); }
    failPending(`Lost the connection to ${deps.label}.`);
  };
  const stopFor = (next: State, msg?: string): void => {
    stopped = true;
    clearTimeout(retry);
    drop();
    // Nothing this shell started is its to watch any more (taken over, or a core it can't talk to).
    if (running.size > 0) { running.clear(); deps.onWorking(false); }
    failOrphans(`Lost the connection to ${deps.label} before the core confirmed the start.`);
    setState(next, msg);
  };
  const lost = (c: SshChild, stderr: string): void => {
    if (child !== c) return;
    drop();
    if (stopped) return;
    const steps = deps.retryMs ?? RETRY_MS;
    const delay = steps[Math.min(failures, steps.length - 1)]!;
    failures++;
    setState("reconnecting", lastLine(stderr) ?? message);
    retry = setTimeout(connect, delay);
  };

  const onFrame = (c: SshChild, m: unknown): void => {
    if (child !== c || !isObj(m)) return;
    switch (m.type) {
      case "attached": {
        const check = checkHandshake(m.handshake);
        if (!check.ok) return stopFor("mismatch", check.message);
        if (typeof m.generation !== "number") return stopFor("mismatch", "The core sent a malformed attach reply.");
        handshake = check.handshake;
        generation = m.generation;
        everAttached = true;
        failures = 0;
        write(c, { type: "resume", acks });
        // The replay above carries any `started` an orphan waits for; one that never comes was never run.
        if (orphans.length > 0) {
          orphanTimer = setTimeout(() => failOrphans(`${deps.label} never confirmed that start — it didn't run.`), ORPHAN_START_MS);
        }
        beat = setInterval(() => { if (child === c) write(c, { type: "heartbeat", acks }); }, HEARTBEAT_MS);
        return setState("attached");
      }
      case "result": {
        const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
        if (!p) return; // a late answer to a call already failed by a drop
        pending.delete(m.id as number);
        if (p.start && m.ok === true) {
          const i = unclaimed.findIndex((u) => u.taskId === m.value);
          if (i >= 0) unclaimed.splice(i, 1);
        }
        if (m.ok === true) p.resolve(m.value);
        else p.reject(new Error(typeof m.error === "string" ? m.error : "The core refused the call."));
        return;
      }
      case "push": {
        if (typeof m.mountId !== "string" || typeof m.seq !== "number" || typeof m.kind !== "string") return;
        acks[m.mountId] = m.seq;
        const p = m.payload as Record<string, unknown> | null;
        if (m.kind === "delegate" && isObj(p) && typeof p.taskId === "string") {
          setWorking(`d:${p.taskId}`, p.type === "started" || p.type === "output");
        } else if (m.kind === "live" && isObj(p) && typeof p.sessionId === "string") {
          setWorking(`l:${p.sessionId}`, p.type !== "ended");
        }
        deps.onPush(m.mountId, m.kind as MountPushKind, m.payload);
        if (m.kind === "delegate" && isObj(p) && p.type === "started" && typeof p.taskId === "string"
          && typeof p.projectPath === "string" && typeof p.instruction === "string") {
          unclaimed.push({ mountId: m.mountId, taskId: p.taskId, projectPath: p.projectPath, instruction: p.instruction });
          if (unclaimed.length > 32) unclaimed.shift();
          matchOrphans();
        }
        return;
      }
      case "revoked":
        return stopFor("revoked");
      case "error": {
        const why = typeof m.message === "string" ? m.message.slice(0, 300) : "The core closed the connection.";
        // A refused contract version comes with the core's handshake: blocking, no retry.
        if (m.handshake !== undefined) {
          const check = checkHandshake(m.handshake);
          return stopFor("mismatch", check.ok ? why : check.message);
        }
        message = why; // shown once the close lands
        return;
      }
    }
  };

  function connect(): void {
    clearTimeout(retry);
    if (stopped || child) return;
    if (state !== "connecting") setState(everAttached ? "reconnecting" : state, message);
    let c: SshChild;
    try { c = deps.spawn(); } catch (err) {
      const fake = {} as SshChild;
      child = fake;
      return lost(fake, err instanceof Error ? err.message : "Couldn't start ssh.");
    }
    child = c;
    let stderr = "";
    c.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-4000); });
    c.stdout.on("data", frameReader((m) => onFrame(c, m), (why) => { message = `The core sent a bad frame: ${why}`; lost(c, ""); }));
    c.stdin.on("error", () => {}); // EPIPE when ssh dies; its close handles the rest
    c.on("error", (err) => lost(c, `${stderr}\n${err.message}`));
    c.on("close", () => lost(c, stderr));
    write(c, { type: "attach", shellId: deps.shellId, contract: CONTRACT_VERSION });
  }

  return {
    connect,
    status,
    handshake: (): Handshake | undefined => (generation === undefined ? undefined : handshake),
    /** One remote-safe operation; rejects at once while not attached (the composer is read-only then). */
    call: (op: string, args: unknown[]): Promise<unknown> => {
      const c = child;
      if (!c || generation === undefined) return Promise.reject(new Error(`Not connected to ${deps.label} — reconnecting.`));
      const id = nextId++;
      const start = startOf(op, args);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, ...(start ? { start } : {}) });
        if (!write(c, { type: "call", id, op, args })) {
          pending.delete(id);
          reject(new Error("That request is too large to send to the core."));
        }
      });
    },
    /** "Take back" after a takeover: attach again (which displaces the other machine). */
    takeBack: (): void => {
      if (state !== "revoked") return;
      stopped = false;
      failures = 0;
      setState("connecting");
      connect();
    },
    /** Quit or switch: a deliberate detach — the core releases this shell's chats now. */
    detach: (): void => {
      if (child && generation !== undefined) write(child, { type: "detach" });
      stopped = true;
      clearTimeout(retry);
      drop();
      failOrphans(`Detached from ${deps.label}.`);
    },
  };
}

export type RemoteCore = ReturnType<typeof createRemoteCore>;

/** The IPC adapter for a remote core: the remote-safe core channels go over the wire, with the chat
 * mounts' windows tracked here so the core's pushes reach the window that holds each chat. Every other
 * core or host-bound channel rejects (capability-gated UI is #812). Each call passes the contract
 * first, as the local adapter's do. Both an invoke handler and a send listener are registered per
 * remote op (whichever the preload uses is the one that fires); a send's failure is only logged. */
export function registerRemoteIpc(electronIpc: IpcLike, deps: {
  core: Pick<RemoteCore, "call" | "handshake">;
  /** mount id → the webContents id that attached it. */
  mounts: Map<string, number>;
}) {
  const ipc = guardIpc(electronIpc, []);
  const call = (key: string, sender: number, args: unknown[]): Promise<unknown> => {
    const mountId = args[0];
    // Recorded before the call: a chat opened while reconnecting is attached again once the core is back.
    if (key === "chatAttach" && typeof mountId === "string") deps.mounts.set(mountId, sender);
    if (key === "chatRelease" && typeof mountId === "string" && deps.mounts.get(mountId) === sender) deps.mounts.delete(mountId);
    return deps.core.call(key, args);
  };
  for (const [key, c] of Object.entries(CHANNEL_CONTRACT)) {
    if (c.owner === "shell") continue;
    const channel = IPC[key as keyof typeof IPC];
    if (key === "handshake") {
      ipc.handle(channel, () => {
        const h = deps.core.handshake();
        if (!h) throw new Error("Not connected to the core — reconnecting.");
        return h;
      });
    } else if (Object.hasOwn(REMOTE_OPS, key)) {
      ipc.handle(channel, (e, ...args: unknown[]) => call(key, e.sender.id, args));
      ipc.on(channel, (e, ...args: unknown[]) => {
        call(key, e.sender.id, args).catch((err: unknown) => console.warn(`bean: ${key} on the remote core failed —`, err instanceof Error ? err.message : err));
      });
    } else {
      ipc.handle(channel, () => { throw new Error(`${key} isn't available on a remote core yet.`); });
    }
  }
  return {
    /** After every (re)attach: the core keeps a reconnecting shell's chats, but a chat opened while it was
     * away never reached it. A chat it already holds is refused there, harmlessly. */
    reattach: (): void => {
      for (const mountId of deps.mounts.keys()) {
        deps.core.call("chatAttach", [mountId]).catch(() => {});
      }
    },
    /** A chat window closed: release its chats on the core (their work stops), like a local window close. */
    releaseClient: (sender: number): void => {
      for (const [mountId, s] of deps.mounts) {
        if (s !== sender) continue;
        deps.mounts.delete(mountId);
        deps.core.call("chatRelease", [mountId]).catch(() => {});
      }
    },
  };
}
