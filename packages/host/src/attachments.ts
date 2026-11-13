import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { ClientId, HostPush, MountPushKind } from "./shell-ops.js";

// The attachment lifecycle of a remote shell (#808). One shell is attached per core; a second attach
// revokes the first before it is acknowledged. A shell that stops heartbeating is disconnected (not
// released): its chats keep their delegates and live sessions for DISCONNECT_GRACE_MS, their pushes
// are numbered and buffered, and a reconnect from the same install replays what it missed. Explicit
// detach releases at once, like a closed local chat window. The in-process Electron shell never
// attaches — local behavior is untouched. Nothing here is persisted (incognito content included).

/** How long a lost shell's chats keep their work (same length as LIVE_SESSION_IDLE_MS, on purpose a
 * separate constant: one is a network drop, the other an idle agent). */
export const DISCONNECT_GRACE_MS = 30 * 60_000;
/** No heartbeat for this long = the shell is gone (it beats every 10 s). */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Events kept per chat for a replay; completions are kept past this until acknowledged. */
export const REPLAY_LIMIT = 256;

/** A host → shell message on the attachment. `seq` counts per chat (mount) from 1. */
export type AttachmentMessage =
  | { type: "push"; mountId: string; seq: number; kind: MountPushKind; payload: unknown }
  // Another attach took this core over; the shell shows "Take back" and doesn't reconnect on its own.
  | { type: "revoked" };

/** Last seq the shell has applied, per chat. */
export type Acks = Record<string, number>;

export class StaleAttachmentError extends Error {
  constructor() { super("This shell is no longer attached to the core."); }
}

export interface AttachmentsDeps {
  /** The client a chat is attached to now (never a released chat). */
  holder: (mountId: string) => ClientId | undefined;
  ofClient: (clientId: ClientId) => string[];
  /** Disconnect: abort Bean's own turn in flight in this chat. */
  abortTurn: (mountId: string) => void;
  /** Grace ran out: close catch-up, then release every chat of the client (cancels its work). */
  expire: (clientId: ClientId) => void;
  /** Explicit detach: release every chat of the client now. */
  release: (clientId: ClientId) => void;
}

interface Shell {
  clientId: ClientId;
  /** The attached connection; undefined while disconnected (in grace) or revoked. */
  conn?: { generation: number; send: (m: AttachmentMessage) => void; resumed: boolean; beat: ReturnType<typeof setTimeout> };
  grace?: ReturnType<typeof setTimeout>;
}

interface Buffer { seq: number; events: Extract<AttachmentMessage, { type: "push" }>[] }

const isCompletion = (kind: MountPushKind, payload: unknown): boolean => {
  const type = (payload as { type?: unknown } | null)?.type;
  return (kind === "delegate" && (type === "done" || type === "failed" || type === "cancelled")) || (kind === "live" && type === "ended");
};

const SHELL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAttachments(deps: AttachmentsDeps) {
  const shells = new Map<string, Shell>(); // per-install shell id → its client
  const buffers = new Map<string, Buffer>(); // per chat (mount id)
  let current: Shell | undefined;
  let generation = 0;
  // Negative: never a webContents id, so an attached shell can't collide with a local window.
  let nextClientId = -1;

  const shellOf = (clientId: ClientId): Shell | undefined => [...shells.values()].find((s) => s.clientId === clientId);
  const live = (gen: unknown): Shell => {
    if (current?.conn === undefined || current.conn.generation !== gen) throw new StaleAttachmentError();
    return current;
  };
  const watchdog = (shell: Shell): ReturnType<typeof setTimeout> => setTimeout(() => disconnect(shell), HEARTBEAT_TIMEOUT_MS);
  const trim = (shell: Shell, acks: unknown): void => {
    if (typeof acks !== "object" || acks === null) return;
    for (const id of deps.ofClient(shell.clientId)) {
      const ack = (acks as Acks)[id];
      const b = buffers.get(id);
      if (b && typeof ack === "number") b.events = b.events.filter((e) => e.seq > ack);
    }
  };
  // A released chat's buffer goes too.
  const sweep = (): void => { for (const id of buffers.keys()) if (deps.holder(id) === undefined) buffers.delete(id); };
  /** The connection is gone (heartbeat lost, or displaced): the chats keep their work for the grace. */
  const disconnect = (shell: Shell): void => {
    if (!shell.conn) return;
    clearTimeout(shell.conn.beat);
    shell.conn = undefined;
    if (current === shell) current = undefined;
    for (const id of deps.ofClient(shell.clientId)) deps.abortTurn(id);
    clearTimeout(shell.grace);
    shell.grace = setTimeout(() => {
      shell.grace = undefined;
      deps.expire(shell.clientId);
      sweep();
    }, DISCONNECT_GRACE_MS);
  };

  return {
    /** Attach a shell (its persistent per-install id): whoever is attached is revoked first. A
     * reconnect from the same install keeps its client and chats; the shell then calls `resume`. */
    attach: (shellId: unknown, send: (m: AttachmentMessage) => void): { generation: number; clientId: ClientId } => {
      if (typeof shellId !== "string" || !SHELL_ID.test(shellId)) throw new Error("malformed shell id");
      if (current?.conn) {
        const prev = current;
        prev.conn?.send({ type: "revoked" });
        disconnect(prev); // not adopted: its chats keep their own grace
      }
      let shell = shells.get(shellId);
      if (!shell) shells.set(shellId, shell = { clientId: nextClientId-- });
      clearTimeout(shell.grace);
      shell.grace = undefined;
      generation += 1;
      shell.conn = { generation, send, resumed: false, beat: watchdog(shell) };
      current = shell;
      return { generation, clientId: shell.clientId };
    },
    /** Throws unless `gen` is the attached generation — before a request, and again after its async work. */
    check: (gen: unknown): void => { live(gen); },
    /** Runs a request for generation `gen`; a displaced shell's request (or its late result) is rejected. */
    run: async <T>(gen: unknown, fn: () => T | Promise<T>): Promise<T> => {
      live(gen);
      const result = await fn();
      live(gen);
      return result;
    },
    /** The shell's heartbeat; `acks` (last applied seq per chat) trims the replay buffers. */
    heartbeat: (gen: unknown, acks?: unknown): void => {
      const shell = live(gen);
      clearTimeout(shell.conn!.beat);
      shell.conn!.beat = watchdog(shell);
      trim(shell, acks);
      sweep();
    },
    /** After attach: replays each chat's events past the shell's acks, once, then delivers live. */
    resume: (gen: unknown, acks: unknown): void => {
      const shell = live(gen);
      const conn = shell.conn!;
      trim(shell, acks);
      for (const id of deps.ofClient(shell.clientId)) for (const e of buffers.get(id)?.events ?? []) conn.send(e);
      conn.resumed = true;
    },
    /** A deliberate detach (the shell quits): its chats are released now, no grace. */
    detach: (gen: unknown): void => {
      const shell = live(gen);
      clearTimeout(shell.conn!.beat);
      shell.conn = undefined;
      current = undefined;
      deps.release(shell.clientId);
      sweep();
    },
    /** Whether a client is an attached (or disconnected, in-grace) remote shell. */
    isClient: (clientId: ClientId): boolean => shellOf(clientId) !== undefined,
    /** Wraps the host's push: a remote shell's chats get numbered, buffered events; everything else
     * goes to `local` unchanged. */
    push: (local: HostPush): HostPush => (mountId, kind, payload) => {
      const clientId = deps.holder(mountId);
      const shell = clientId === undefined ? undefined : shellOf(clientId);
      if (!shell) { local(mountId, kind, payload); return; }
      const b = buffers.get(mountId) ?? { seq: 0, events: [] };
      buffers.set(mountId, b);
      const e = { type: "push" as const, mountId, seq: ++b.seq, kind, payload };
      b.events.push(e);
      // Bounded: drop the oldest non-completion events (output lines); completions wait for an ack.
      for (let i = 0; b.events.length > REPLAY_LIMIT && i < b.events.length;) {
        const old = b.events[i]!;
        if (isCompletion(old.kind, old.payload)) i++;
        else b.events.splice(i, 1);
      }
      if (shell.conn?.resumed) shell.conn.send(e);
    },
  };
}

export type Attachments = ReturnType<typeof createAttachments>;

/** The shell's persistent per-install id: read from `file`, or created (0600) on first use. */
export function shellClientId(file: string): string {
  try {
    const id = readFileSync(file, "utf8").trim();
    if (SHELL_ID.test(id)) return id;
  } catch { /* first run */ }
  const id = randomUUID();
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return id;
}
