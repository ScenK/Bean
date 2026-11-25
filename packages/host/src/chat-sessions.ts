import {
  createGrant, dispatchContext, GRANT_MISMATCH_TEXT, matchGrant, refreshGrant, revokeGrant, stageImages,
  type ChatRequest, type ConverseResult, type DelegateGrant, type Dispatch, type SproutOrigin, type TriggerResult,
} from "@bean/core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatMounts, THREAD_ID, type buildChatHandler, type buildChatThreadHandlers, type SproutEvent, type SproutOutcome, type SproutStarted } from "./chat.js";
import type { DelegateStartOpts, DelegateStartRequest } from "./delegate-tasks.js";
import type { createLiveTasks, LiveOwner } from "./live-tasks.js";
import { EPISODE_IDLE_MS, toTranscript, type buildMemoryHandlers, type CloseTurn } from "./memory.js";
import type { ClientId, HostPush } from "./shell-ops.js";

export interface ChatSessionsDeps {
  /** Whether a client is the chat window — the only client whose chats (mounts) may attach. */
  isChatClient: (clientId: ClientId) => boolean;
  chat: ReturnType<typeof buildChatHandler>;
  memory: ReturnType<typeof buildMemoryHandlers>;
  threads: ReturnType<typeof buildChatThreadHandlers>;
  delegateTasks: {
    start: (req: DelegateStartRequest, opts?: DelegateStartOpts) => Promise<string>;
    cancelMount: (mountId: string) => void;
    busy: (sessionId: string) => boolean;
  };
  liveTasks: Pick<ReturnType<typeof createLiveTasks>, "start" | "send" | "stop" | "interrupt" | "resume" | "stopMount" | "holds">;
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
  /** A todo card's Run now / Queue (#923): queues the todo with its dispatch (origin = the chat's
   * thread); Run now then runs only it (`running`) or leaves it first in line (`next`). `reason` = it
   * didn't start (still queued). Absent = the card can't dispatch here. */
  todoDispatch?: (todo: { routine: string; text: string }, mode: "run" | "queue", origin: { channel: string; keepBrief: boolean })
    => Promise<TodoDispatchAnswer>;
  /** A restored thread's sprout dispatches, the closed ones marked delivered (#921). */
  sproutOutcomes?: (thread: string) => SproutOutcome[];
  /** Epoch ms, for the task grants' idle clock (tests). */
  now?: () => number;
}

/** What a todo card's tap did (#923): `jobId` names the dispatch its result comes back under. */
export interface TodoDispatchAnswer { jobId: string; outcome: "running" | "next" | "queued"; ahead?: number; reason?: string }

/** A chat sprout run that was admitted but couldn't be recorded: it runs on, with no result turn. */
export const SPROUT_UNRECORDED = "Started — see the Dashboard for how it went";

const NOT_LIVE = "Agent sessions run from the chat window.";
const DELEGATE_HOLDS = "A background run is still working in that session — wait for it to finish.";
/** The desktop is its owner's machine: one actor confirms and continues every chat's tasks. */
const DESKTOP_ACTOR = "owner";
/** Turns that may continue a task: what the user typed or ran — never a loopback (epic #1111). */
const CAN_CONTINUE = new Set(["typed", "skill"]);
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
  // Each chat's quiet timer (see `chat` below); a release or a close ends the watch.
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  // ponytail: an env override rather than a Settings knob — the e2e suite shortens the wait, and
  // it is the one dial to turn if 10 minutes proves wrong in use.
  const idleMs = Number(process.env.BEAN_EPISODE_IDLE_MS) > 0 ? Number(process.env.BEAN_EPISODE_IDLE_MS) : EPISODE_IDLE_MS;
  const unwatch = (id: string): void => { clearTimeout(idle.get(id)); idle.delete(id); };
  // Sprout runs started here (#921): their thread → the chat that started it, so its result reaches
  // that chat even when the thread isn't pinned (not saved yet, or off the record). Dropped at release.
  const sproutThreads = new Map<string, string>();
  // Each chat's task grant (epic #1111, core delegate-grant.ts): a confirmed delegate card that
  // reported its CLI session lets that chat's follow-ups resume it without a card. Memory only;
  // dropped with the chat, revoked by its Dismiss/End.
  const now = deps.now ?? Date.now;
  const grants = new Map<string, { grant: DelegateGrant; instruction: string }>();
  // A run on the grant's session settled: its idle clock restarts; a refused resume ends the grant.
  const touch = (k: string, sessionId: string, e: { type: string; resumeRefused?: true }): boolean => {
    const g = grants.get(k);
    if (!g || g.grant.revoked || g.grant.sessionId !== sessionId) return false;
    if (e.type === "failed" && e.resumeRefused) {
      grants.set(k, { ...g, grant: revokeGrant(g.grant) });
      return false;
    }
    grants.set(k, { ...g, grant: refreshGrant(g.grant, now()) });
    return true;
  };
  const revoke = (k: string): void => {
    const g = grants.get(k);
    if (g) grants.set(k, { ...g, grant: revokeGrant(g.grant) });
  };
  /** A `continue` proposal: started at once when it matches the grant offered with the turn (and no
   * run or live session holds that session), else back to a normal card with the reason. */
  const continueDelegate = async (k: string, result: ConverseResult, offered: DelegateGrant): Promise<void> => {
    const { continue: _c, ...plain } = result.proposedDelegate!;
    const fallback = (why: string): void => { result.proposedDelegate = plain; result.delegateNotice = why; };
    const m = matchGrant(grants.get(k)?.grant, {
      surface: "desktop", scopeKey: k, actorId: DESKTOP_ACTOR, projectPath: plain.projectPath,
      ...(plain.cli ? { cli: plain.cli } : {}), ...(plain.model ? { model: plain.model } : {}),
      ...(plain.skillName ? { skillName: plain.skillName } : {}), generation: offered.generation,
    }, now());
    if (!m.ok) return fallback(GRANT_MISMATCH_TEXT[m.reason]);
    const g = m.grant;
    if (deps.delegateTasks.busy(g.sessionId) || deps.liveTasks.holds(g.sessionId)) return fallback(GRANT_MISMATCH_TEXT.busy);
    const refused = deps.refuseStart?.();
    if (refused) return fallback(refused);
    grants.set(k, { grant: refreshGrant(g, now()), instruction: plain.instruction });
    const proposal = {
      ...plain, projectPath: g.projectPath, cli: g.cli,
      ...(g.model ? { model: g.model } : {}), ...(g.skillName ? { skillName: g.skillName } : {}),
    };
    const started = deps.delegateTasks.start({
      projectPath: g.projectPath, prompt: plain.composedPrompt, instruction: plain.instruction, cli: g.cli,
      ...(g.model ? { model: g.model } : {}), ...(g.skillName ? { skillName: g.skillName } : {}),
      offRecord: deps.memory.isIncognito(k), mountId: k,
    }, { resume: g.sessionId, continued: proposal, browserAllowed: g.browser, onEnd: (e) => touch(k, g.sessionId, e) });
    const taskId = await (deps.track ? deps.track(started) : started);
    // Released while it started (the release's cancelMount ran before the task existed).
    if (mounts.holder(k) === undefined) deps.delegateTasks.cancelMount(k);
    delete result.proposedDelegate;
    result.continuedDelegate = { taskId, proposal };
  };
  const release = (client: ClientId, mountId: unknown): void => {
    if (!mounts.release(client, mountId)) return;
    const id = mountId as string;
    grants.delete(id);
    for (const [thread, k] of sproutThreads) if (k === id) sproutThreads.delete(thread);
    beanTurns.get(id)?.ctl.abort();
    transcripts.delete(id);
    unwatch(id);
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
    /** Whether this chat (mount key) is Home on the main conversation's log (#997). */
    isMain: (k: string): boolean => deps.threads.isMain(k),
    /** The chat threads a chat (mount key) dispatches sprouts from: its pinned thread and any it
     * started a sprout under (#924, background_work). */
    threadsOf: (k: string): string[] => {
      const out = new Set<string>();
      const pinned = deps.threads.pinnedOf(k);
      if (pinned !== undefined) out.add(pinned);
      for (const [thread, owner] of sproutThreads) if (owner === k) out.add(thread);
      return [...out];
    },
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
      // The chat's live grant, offered to the model as a session it may continue (typed turns only).
      const g = grants.get(k);
      const offered = g && CAN_CONTINUE.has(req?.source ?? "typed") && matchGrant(g.grant, { surface: "desktop", scopeKey: k, actorId: DESKTOP_ACTOR }, now()).ok
        ? g : undefined;
      try {
        const result = await deps.chat(req, client, k, turn.ctl.signal, offered
          ? { cli: offered.grant.cli, projectPath: offered.grant.projectPath, lastInstruction: offered.instruction } : undefined);
        if (result.proposedDelegate?.continue) {
          if (offered && !result.stopped && mounts.holder(k) !== undefined) await continueDelegate(k, result, offered.grant);
          else { const { continue: _c, ...plain } = result.proposedDelegate; result.proposedDelegate = plain; }
        }
        end?.(result.error);
        // Stopped by the user: no error bubble, and nothing of this turn is captured as memory.
        if (result.stopped) return result;
        // An off-the-record exchange is never recorded: switching the chip back off must not
        // hand it to the next episode.
        if (!result.error && mounts.holder(k) !== undefined && !req.incognito && !deps.memory.isIncognito(k)) {
          const t = transcripts.get(k) ?? { turns: [], typed: false };
          t.turns.push({ role: "user", content: req.message, source: req.source, ...(req.turnId ? { id: req.turnId } : {}) });
          t.turns.push({ role: "assistant", content: result.reply });
          t.turns.splice(0, t.turns.length - TRANSCRIPT_TURNS);
          t.typed ||= req.source === "typed";
          transcripts.set(k, t);
        }
        // Memory is written per episode, not per turn: once this chat has been quiet for
        // EPISODE_IDLE_MS (a close or a switch away gets there first), everything since the last
        // episode is reviewed in one pass. The receipt row is tagged with its chat, which may no
        // longer be the visible one.
        // A turn that isn't typed (a delegate result) restarts a wait already running.
        const watching = idle.has(k);
        unwatch(k);
        if (deps.memory.noteTurn(k, req, result) || watching) {
          const timer = setTimeout(() => {
            idle.delete(k);
            const t = transcripts.get(k);
            if (!t?.typed) return;
            deps.memory.rememberIdle(k, [...t.turns]).then((batch) => {
              if (batch.length > 0) {
                deps.push(k, "memory", { saved: batch.map(({ id, text, category }) => ({ id, text, category })), mountId: k });
              }
            }).catch((err) => console.error("idle memory episode failed:", err));
          }, idleMs);
          timer.unref?.();
          idle.set(k, timer);
        }
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
    threadSave: (client: ClientId, mountId: unknown, req: unknown, opts?: { keepNote?: boolean }) => deps.threads.save(key(client, mountId), req, opts),
    /** Home's owner-DM rows past its cursor (#1000); refused for any chat but Home on the main log. */
    mainSince: (client: ClientId, mountId: unknown, cursor: unknown) => deps.threads.mainSince(key(client, mountId), cursor),
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
    /** A todo card's Run now / Queue (#923). Its result reaches the chat holding `thread` as a
     * `sprout` push, like a sprout card's. */
    todoDispatch: async (client: ClientId, mountId: unknown, routine: unknown, text: unknown, mode: unknown, thread: unknown): Promise<TodoDispatchAnswer | { reason: string }> => {
      const k = key(client, mountId);
      if (typeof routine !== "string" || !routine || typeof text !== "string" || !text.trim()) throw new Error("todo needs a sprout and a task");
      if (mode !== "run" && mode !== "queue") throw new Error("mode must be run or queue");
      if (typeof thread !== "string" || !THREAD_ID.test(thread)) throw new Error("chat thread id must be a UUID");
      const pinned = deps.threads.pinnedOf(k);
      const other = deps.threads.holderOf(thread) ?? sproutThreads.get(thread);
      if ((pinned !== undefined && pinned !== thread) || (other !== undefined && other !== k)) throw new Error("this chat saves a different chat thread");
      const refused = mode === "run" ? deps.refuseStart?.() : undefined;
      if (refused) return { reason: refused };
      if (!deps.todoDispatch) return { reason: "Sprouts don't take tasks from chats on this Bean." };
      sproutThreads.set(thread, k);
      return deps.todoDispatch({ routine, text }, mode, { channel: thread, keepBrief: !deps.memory.isIncognito(k) });
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
      unwatch(k);
      deps.memory.rememberOnClose(toTranscript(transcript), { incognito, rejected, key: k }).catch((err) => {
        console.error("auto-remember failed:", err);
      });
    },
    delegateStart: (client: ClientId, mountId: unknown, req: DelegateStartRequest): Promise<string> => {
      const k = key(client, mountId);
      const refused = deps.refuseStart?.();
      if (refused) return Promise.reject(new Error(refused));
      const instruction = typeof req?.instruction === "string" ? req.instruction : "";
      // A confirmed card grants its task once the run reports its CLI session (replacing any older grant).
      let session: string | undefined;
      const started = deps.delegateTasks.start({ ...req, offRecord: deps.memory.isIncognito(k), mountId: k }, {
        onSession: (s) => {
          if (mounts.holder(k) === undefined) return;
          session = s.sessionId;
          const grant = createGrant({
            surface: "desktop", scopeKey: k, actorId: DESKTOP_ACTOR, projectPath: s.projectPath, cli: s.cli,
            ...(s.model ? { model: s.model } : {}), ...(req.skillName ? { skillName: req.skillName } : {}),
            browser: s.browser, sessionId: s.sessionId,
          }, now(), grants.get(k)?.grant);
          grants.set(k, { grant, instruction });
        },
        onEnd: (e) => session !== undefined && touch(k, session, e),
      });
      return deps.track ? deps.track(started) : started;
    },
    /** Dismiss on a delegate card, or End of the chat's agent session: its task grant ends. */
    revokeGrant: (client: ClientId, mountId: unknown): void => {
      const k = tryKey(client, mountId);
      if (k !== undefined) revoke(k);
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
      // Never two writers on one session: a delegate (a continuation, even still starting) holds it.
      if (typeof sessionId === "string" && deps.delegateTasks.busy(sessionId)) return { error: DELEGATE_HOLDS };
      return o ? deps.liveTasks.resume(o, sessionId) : { error: NOT_LIVE };
    },
  };
}

export type ChatSessions = ReturnType<typeof createChatSessions>;
