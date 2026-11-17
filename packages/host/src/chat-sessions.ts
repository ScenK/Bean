import { dispatchContext, stageImages, type ChatRequest, type ConverseResult, type Dispatch, type SproutOrigin, type TriggerResult } from "@bean/core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatMounts, THREAD_ID, type buildChatHandler, type buildChatThreadHandlers, type SproutEvent, type SproutOutcome, type SproutStarted } from "./chat.js";
import type { DelegateStartRequest } from "./delegate-tasks.js";
import type { createLiveTasks, LiveOwner } from "./live-tasks.js";
import { toTranscript, type buildMemoryHandlers, type CloseTurn } from "./memory.js";
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
  /** Why a new chat turn, delegate or live session can't start now (a core update, #837), or undefined. */
  refuseStart?: () => string | undefined;
  /** Counts an admitted start as busy until it settles: its async checks run before it shows as a job (#837). */
  track?: <T>(start: Promise<T>) => Promise<T>;
  /** Runs a sprout for a chat, recording its dispatch (`withDispatch`, surface desktop): `jobId`
   * names it. Absent = sprouts don't run from chats here. */
  sproutRun?: (name: string, origin: SproutOrigin) => Promise<TriggerResult & { jobId?: string }>;
  /** A restored thread's sprout dispatches, the closed ones marked delivered (#921). */
  sproutOutcomes?: (thread: string) => SproutOutcome[];
}

/** A chat sprout run that was admitted but couldn't be recorded: it runs on, with no result turn. */
export const SPROUT_UNRECORDED = "Started — see the Dashboard for how it went";

const NOT_LIVE = "Agent sessions run from the chat window.";
// ponytail: the newest turns kept per chat for a host-run close catch-up; a longer chat's oldest
// turns are only covered by their per-turn captures.
const TRANSCRIPT_TURNS = 100;

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
  // The Bean turns each chat ran through this host (in memory only, dropped at release), for the
  // close catch-up a lost shell can't send itself (#808). A turn per-turn capture handled carries its
  // id, so the catch-up treats it as context; nothing typed = nothing to extract.
  const transcripts = new Map<string, { turns: CloseTurn[]; typed: boolean }>();
  // Sprout runs started here (#921): their thread → the chat that started it, so its result reaches
  // that chat even when the thread isn't pinned (not saved yet, or off the record). Dropped at release.
  const sproutThreads = new Map<string, string>();
  const release = (client: ClientId, mountId: unknown): void => {
    if (!mounts.release(client, mountId)) return;
    const id = mountId as string;
    for (const [thread, k] of sproutThreads) if (k === id) sproutThreads.delete(thread);
    beanTurns.get(id)?.ctl.abort();
    transcripts.delete(id);
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
    /** The client a chat is attached to now (never a released one). */
    holder: mounts.holder,
    ofClient: mounts.ofClient,
    /** The shell holding this chat dropped: abort Bean's turn in flight (its reply has nowhere to go). */
    abortTurn: (mountId: string): void => beanTurns.get(mountId)?.ctl.abort(),
    /** A lost shell's grace ran out: each chat gets the close catch-up it would have sent, then is
     * released (delegates cancelled, live session stopped). */
    expireClient: (client: ClientId): void => {
      for (const id of mounts.ofClient(client)) {
        const t = transcripts.get(id);
        if (t?.typed) {
          deps.memory.rememberOnClose(t.turns, { incognito: deps.memory.isIncognito(id), rejected: [], key: id })
            .catch((err) => console.error("auto-remember failed:", err));
        }
        release(client, id);
      }
    },
    chat: async (client: ClientId, mountId: unknown, req: ChatRequest): Promise<ConverseResult> => {
      const k = key(client, mountId);
      const refused = deps.refuseStart?.();
      if (refused) throw new Error(refused);
      // Registered before any await, so a Stop that lands while the loaders run still aborts.
      const turn = { turnId: req?.turnId, ctl: new AbortController() };
      beanTurns.set(k, turn);
      const end = deps.onChatTurn?.(k);
      try {
        const result = await deps.chat(req, client, k, turn.ctl.signal);
        end?.(result.error);
        // Stopped by the user: no error bubble, and nothing of this turn is captured as memory.
        if (result.stopped) return result;
        if (!result.error && mounts.holder(k) !== undefined) {
          const t = transcripts.get(k) ?? { turns: [], typed: false };
          t.turns.push({ role: "user", content: req.message, source: req.source, ...(req.turnId ? { id: req.turnId } : {}) });
          t.turns.push({ role: "assistant", content: result.reply });
          t.turns.splice(0, t.turns.length - TRANSCRIPT_TURNS);
          t.typed ||= req.source === "typed";
          transcripts.set(k, t);
        }
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
    // A restored thread carries its sprout runs' outcomes: its running cards settle (and loop the
    // result back) from them, however long the chat was closed.
    threadGet: (client: ClientId, mountId: unknown, id: unknown) => {
      const t = deps.threads.get(key(client, mountId), id);
      if ("missing" in t || !deps.sproutOutcomes) return t;
      let sprouts: SproutOutcome[] = [];
      try { sprouts = deps.sproutOutcomes(t.id); } catch (err) { console.error("bean: reading a chat's sprout runs failed", err); }
      return sprouts.length > 0 ? { ...t, sprouts } : t;
    },
    /** A sprout card's Run (#921): answers at admission with the run's job id (or why it didn't
     * start). Its end reaches the chat holding `thread` as a `sprout` push (`deliverSprout`). */
    sproutRun: async (client: ClientId, mountId: unknown, name: unknown, thread: unknown): Promise<{ jobId?: string; reason?: string }> => {
      const k = key(client, mountId);
      if (typeof name !== "string" || !name) throw new Error("sprout name must be a string");
      if (typeof thread !== "string" || !THREAD_ID.test(thread)) throw new Error("chat thread id must be a UUID");
      const pinned = deps.threads.pinnedOf(k);
      const other = deps.threads.holderOf(thread) ?? sproutThreads.get(thread);
      if ((pinned !== undefined && pinned !== thread) || (other !== undefined && other !== k)) throw new Error("this chat saves a different chat thread");
      const refused = deps.refuseStart?.();
      if (refused) return { reason: refused };
      if (!deps.sproutRun) return { reason: "Sprouts don't run from chats on this Bean." };
      sproutThreads.set(thread, k);
      const t = await deps.sproutRun(name, { channel: thread, keepBrief: !deps.memory.isIncognito(k) });
      if (t.status === "refused") return { reason: t.reason };
      if (t.status !== "started" || !t.jobId) return { reason: SPROUT_UNRECORDED };
      const started: SproutStarted = { mountId: k, jobId: t.jobId, name };
      deps.push(k, "sprout", started);
      return { jobId: t.jobId };
    },
    /** A desktop dispatch's hand-off: pushed to the chat that holds its thread. False = no open chat
     * has it yet (it's delivered when that thread is restored); a thread that no chat holds and
     * history doesn't have (off the record, deleted) can never take it, so it's dropped (true). */
    deliverSprout: (d: Dispatch): boolean => {
      const thread = d.conversation;
      if (thread === undefined || d.status === undefined) return true;
      const started = sproutThreads.get(thread);
      const k = started !== undefined && mounts.holder(started) !== undefined ? started : deps.threads.holderOf(thread);
      if (k === undefined) return !deps.threads.exists(thread);
      const event: SproutEvent = { mountId: k, jobId: d.id, status: d.status, text: dispatchContext(d) };
      deps.push(k, "sprout", event);
      return true;
    },
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
      const refused = deps.refuseStart?.();
      if (refused) return Promise.reject(new Error(refused));
      const started = deps.delegateTasks.start({ ...req, offRecord: deps.memory.isIncognito(k), mountId: k });
      return deps.track ? deps.track(started) : started;
    },
    // Sessions belong to one chat (client + attached mount); every payload is validated in live-tasks.
    liveStart: (client: ClientId, mountId: unknown, req: unknown) => {
      const o = liveOwner(client, mountId);
      const refused = deps.refuseStart?.();
      if (refused) return { error: refused };
      if (!o) return { error: NOT_LIVE };
      const started = deps.liveTasks.start(o, req);
      return deps.track ? deps.track(started) : started;
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
      const refused = deps.refuseStart?.();
      if (refused) return { error: refused };
      return o ? deps.liveTasks.resume(o, sessionId) : { error: NOT_LIVE };
    },
  };
}

export type ChatSessions = ReturnType<typeof createChatSessions>;
