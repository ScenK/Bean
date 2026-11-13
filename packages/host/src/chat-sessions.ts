import { stageImages, type ChatRequest, type ConverseResult } from "@bean/core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatMounts, type buildChatHandler, type buildChatThreadHandlers } from "./chat.js";
import type { DelegateStartRequest } from "./delegate-tasks.js";
import type { createLiveTasks, LiveOwner } from "./live-tasks.js";
import { toTranscript, type buildMemoryHandlers } from "./memory.js";
import type { ClientId, HostPush } from "./shell-ops.js";

export interface ChatSessionsDeps {
  /** Whether a client is the chat window — the only client whose chats (mounts) may attach. */
  isChatClient: (clientId: ClientId) => boolean;
  chat: ReturnType<typeof buildChatHandler>;
  memory: ReturnType<typeof buildMemoryHandlers>;
  threads: ReturnType<typeof buildChatThreadHandlers>;
  delegateTasks: { start: (req: DelegateStartRequest) => Promise<string>; cancelMount: (mountId: string) => void };
  liveTasks: Pick<ReturnType<typeof createLiveTasks>, "start" | "send" | "stop" | "interrupt" | "resume" | "stopMount">;
  push: HostPush;
  /** Called as a chat (mount) turn starts; the returned fn is called when it ends (with the failure, if any). */
  onChatTurn?: (mountId: string) => (error?: string) => void;
  /** Shell-owned per-chat state (the desktop's terminals) to drop with the chat. */
  onRelease?: (mountId: string) => void;
}

const NOT_LIVE = "Agent sessions run from the chat window.";

/** Every chat (mount) in a client: attach/release, Bean's turn and its Stop, the incognito latch,
 * and the per-chat starts of delegates and live sessions. Every call names its client and mount id
 * and is refused unless that client is the chat window and the mount is attached to it. A release
 * aborts the turn and drops the chat's thread pin/latch, memory state, delegates, live session and
 * `onRelease` state. */
export function createChatSessions(deps: ChatSessionsDeps) {
  const mounts = buildChatMounts();
  const key = (client: ClientId, mountId: unknown): string => {
    if (!deps.isChatClient(client)) throw new Error("Chats run in the chat window.");
    return mounts.key(client, mountId);
  };
  // For fire-and-forget calls: a refused request is dropped, never thrown into the void.
  const tryKey = (client: ClientId, mountId: unknown): string | undefined => {
    try { return key(client, mountId); } catch { return undefined; }
  };
  // Bean's running turn per chat (mount key), so Stop / Esc Esc and a release can abort it.
  const beanTurns = new Map<string, { turnId: unknown; ctl: AbortController }>();
  const release = (client: ClientId, mountId: unknown): void => {
    if (!mounts.release(client, mountId)) return;
    const id = mountId as string;
    beanTurns.get(id)?.ctl.abort();
    deps.memory.release(id);
    deps.threads.release(id);
    deps.delegateTasks.cancelMount(id);
    deps.liveTasks.stopMount(id);
    deps.onRelease?.(id);
  };
  const liveOwner = (client: ClientId, mountId: unknown): LiveOwner | undefined => {
    const k = tryKey(client, mountId);
    return k === undefined ? undefined : { clientId: client, mountId: k };
  };
  // Agent-mode images: a paste or browser drag has no file on disk, so it's written to a private
  // temp dir (one per run) and the agent reads it by path. stageImages checks mime + size.
  let stageDir: Promise<string> | undefined;

  return {
    key,
    tryKey,
    /** Where a mount-tagged push goes: the client holding the mount, or the one that last held it. */
    clientOf: mounts.clientOf,
    isIncognito: (k: string): boolean => deps.memory.isIncognito(k),
    attach: (client: ClientId, mountId: unknown): void => {
      if (deps.isChatClient(client) && !mounts.attach(client, mountId)) console.error("chat attach refused");
    },
    release,
    /** A chat window is gone: release every chat it still had attached. */
    releaseClient: (client: ClientId): void => { for (const id of mounts.ofClient(client)) release(client, id); },
    chat: async (client: ClientId, mountId: unknown, req: ChatRequest): Promise<ConverseResult> => {
      const k = key(client, mountId);
      // Registered before any await, so a Stop that lands while the loaders run still aborts.
      const turn = { turnId: req?.turnId, ctl: new AbortController() };
      beanTurns.set(k, turn);
      const end = deps.onChatTurn?.(k);
      try {
        const result = await deps.chat(req, client, k, turn.ctl.signal);
        end?.(result.error);
        // Stopped by the user: no error bubble, and nothing of this turn is captured as memory.
        if (result.stopped) return result;
        // Fire-and-forget, off the reply path: the reply returns now, the receipt row follows —
        // tagged with its chat, which may no longer be the visible one.
        deps.memory.captureTurn(k, req, result).then((batch) => {
          if (batch.length > 0) {
            deps.push(k, "memory", { saved: batch.map(({ id, text, category }) => ({ id, text, category })), mountId: k });
          }
        }).catch((err) => console.error("per-turn memory capture failed:", err));
        return result;
      } catch (err) {
        end?.(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        if (beanTurns.get(k) === turn) beanTurns.delete(k);
      }
    },
    /** Only the running turn it names: a late Stop must not abort the next turn. */
    stop: (client: ClientId, mountId: unknown, turnId: unknown): void => {
      const k = tryKey(client, mountId);
      const turn = k === undefined ? undefined : beanTurns.get(k);
      if (turn && typeof turnId === "string" && turn.turnId === turnId) turn.ctl.abort();
    },
    stageImage: async (client: ClientId, mountId: unknown, data: unknown, mime: unknown): Promise<string | undefined> => {
      key(client, mountId);
      if (typeof data !== "string" || typeof mime !== "string") throw new Error("malformed image");
      stageDir ??= mkdtemp(join(tmpdir(), "bean-images-")).catch((err: unknown) => { stageDir = undefined; throw err; });
      const [path] = await stageImages([{ data, mimeType: mime }], await stageDir);
      return path;
    },
    incognito: (client: ClientId, mountId: unknown, on: unknown): void => {
      const k = tryKey(client, mountId);
      if (k === undefined) return;
      deps.memory.setIncognito(k, on === true);
      try { deps.threads.setIncognito(k, on === true); } catch (err) { console.error("chat history delete failed:", err); }
    },
    threadSave: (client: ClientId, mountId: unknown, req: unknown) => deps.threads.save(key(client, mountId), req),
    threadGet: (client: ClientId, mountId: unknown, id: unknown) => deps.threads.get(key(client, mountId), id),
    /** The chat is closing: its typed transcript goes to memory in the background. */
    rememberOnClose: (client: ClientId, transcript: unknown, opts: unknown): void => {
      const o = opts as { incognito?: unknown; rejected?: unknown; mountId?: unknown } | null;
      const k = tryKey(client, o?.mountId);
      if (k === undefined) return;
      const incognito = o?.incognito === true;
      const rejected = Array.isArray(o?.rejected) ? o.rejected.filter((t): t is string => typeof t === "string") : [];
      deps.memory.rememberOnClose(toTranscript(transcript), { incognito, rejected, key: k }).catch((err) => {
        console.error("auto-remember failed:", err);
      });
    },
    delegateStart: (client: ClientId, mountId: unknown, req: DelegateStartRequest): Promise<string> => {
      const k = key(client, mountId);
      return deps.delegateTasks.start({ ...req, offRecord: deps.memory.isIncognito(k), mountId: k });
    },
    // Sessions belong to one chat (client + attached mount); every payload is validated in live-tasks.
    liveStart: (client: ClientId, mountId: unknown, req: unknown) => {
      const o = liveOwner(client, mountId);
      return o ? deps.liveTasks.start(o, req) : { error: NOT_LIVE };
    },
    liveSend: (client: ClientId, mountId: unknown, sessionId: unknown, text: unknown) => {
      const o = liveOwner(client, mountId);
      return o ? deps.liveTasks.send(o, sessionId, text) : NOT_LIVE;
    },
    liveStop: (client: ClientId, mountId: unknown, sessionId: unknown): void => {
      const o = liveOwner(client, mountId);
      if (o) deps.liveTasks.stop(o, sessionId);
    },
    liveInterrupt: (client: ClientId, mountId: unknown, sessionId: unknown, turns: unknown) => {
      const o = liveOwner(client, mountId);
      return o ? deps.liveTasks.interrupt(o, sessionId, turns) : false;
    },
    liveResume: (client: ClientId, mountId: unknown, sessionId: unknown) => {
      const o = liveOwner(client, mountId);
      return o ? deps.liveTasks.resume(o, sessionId) : { error: NOT_LIVE };
    },
  };
}

export type ChatSessions = ReturnType<typeof createChatSessions>;
