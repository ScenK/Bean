import { randomUUID } from "node:crypto";
import {
  startLiveSession as defaultStartLiveSession,
  type LiveSessionCallbacks, type LiveSessionHandle, type LiveSessionRequest, type TurnSummary,
} from "../live-session.js";
import { reserveRun, releaseRun, updateReservationPid } from "../run-queue.js";

/** Surface-agnostic "post or edit a plain text message". Chatops builds this on top of
 * BotEffects: post = postCard({content}), edit = updateCard(id, {content}). */
export interface LiveSessionSink {
  post: (text: string) => Promise<string>;
  edit: (id: string, text: string) => Promise<void>;
}

/** Who may steer an active session:
 * - `"open"` — war-room: anyone who can post in the channel sends the agent a turn.
 * - `"restricted"` — only the starter and co-drivers they've added. */
export type SteeringMode = "open" | "restricted";

export interface LiveSessionStart {
  channelId: string;
  projectPath: string;
  instruction: string;
  model?: string;
  /** Surface user-id of whoever tapped Start — the session's owner. Defaults to "" (no owner)
   * for callers that don't care, which only matters under "restricted". */
  starterId?: string;
  /** Defaults to "open" so callers that don't opt in keep the original war-room behavior. */
  steering?: SteeringMode;
  sink: LiveSessionSink;
  /** Each completed turn's final result — callers append it to conversation history. */
  onTurnResult?: (result: string) => void;
  /** Fires exactly once, after cleanup, with a human-readable end notice. */
  onEnded?: (notice: string) => void;
}

type StartFn = (
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn?: never,
  idleTimeoutMs?: number,
) => LiveSessionHandle;

// Headroom under Discord's 2000-char message cap (embeds/formatting stay clear of the edge).
const MSG_LIMIT = 1900;
const DEFAULT_THROTTLE_MS = 1500;

function turnFooter(s: TurnSummary): string {
  const parts: string[] = [];
  if (s.durationMs !== undefined) parts.push(`${(s.durationMs / 1000).toFixed(1)}s`);
  if (s.costUsd !== undefined) parts.push(`$${s.costUsd.toFixed(4)}`);
  return `— turn done${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

interface ActiveSession {
  handle: LiveSessionHandle;
  projectPath: string;
  starterId: string;
  steering: SteeringMode;
  /** Extra user-ids the starter has granted steering to (restricted mode only). */
  coDrivers: Set<string>;
  sink: LiveSessionSink;
  timer: ReturnType<typeof setInterval>;
  /** Current turn's text not yet finalized into a full message — the source of truth;
   * a failed post/edit just leaves it dirty for the next tick. */
  buf: string;
  msgId: string | undefined;
  dirty: boolean;
  rendering: boolean;
  /** The currently in-flight flushSession() run, if any — teardown awaits this before its
   * own final flush so an in-progress send isn't silently dropped by the rendering guard. */
  inFlight?: Promise<void>;
  /** Set on turn completion: after the next successful flush, reset for a fresh message. */
  closeAfterFlush: boolean;
  onEnded?: (notice: string) => void;
}

export interface LiveSessionRegistryOptions {
  /** ~/.bean, for the cross-process/cross-surface project-path reservation (run-queue.ts) —
   * the same one delegate runs (RunRegistry) use, so a live session can't spawn a second
   * permissions-bypassed agent in a project another channel or a delegate run already holds. */
  dir: string;
  throttleMs?: number;
  idleTimeoutMs?: number;
  newId?: () => string;
}

/** channelId → active live session. One session per channel; while bound, the bot routes
 * that channel's messages to the session instead of converse(). Also enforces one session
 * per *project*, cross-process, via the same reservation delegate runs use. */
export class LiveSessionRegistry {
  private byChannel = new Map<string, ActiveSession>();

  constructor(
    private startFn: StartFn = defaultStartLiveSession as StartFn,
    private opts: LiveSessionRegistryOptions,
  ) {}

  private newId(): string {
    return this.opts.newId?.() ?? randomUUID();
  }

  has(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  /** True if `userId` started the session in this channel. */
  isStarter(channelId: string, userId: string): boolean {
    const s = this.byChannel.get(channelId);
    return !!s && s.starterId === userId && userId !== "";
  }

  /** Whether `userId` is allowed to send this channel's session a turn (or stop it). Open mode:
   * anyone. Restricted: the starter or a co-driver. No session → false. */
  canSteer(channelId: string, userId: string): boolean {
    const s = this.byChannel.get(channelId);
    if (!s) return false;
    if (s.steering === "open") return true;
    return s.starterId === userId || s.coDrivers.has(userId);
  }

  /** Grant steering to `userId` (restricted mode). Returns false if there's no session or the
   * id is already the starter / already a co-driver. */
  addCoDriver(channelId: string, userId: string): boolean {
    const s = this.byChannel.get(channelId);
    if (!s || userId === "" || userId === s.starterId || s.coDrivers.has(userId)) return false;
    s.coDrivers.add(userId);
    return true;
  }

  /** Revoke a co-driver. Returns false if there's no session or they weren't one. */
  removeCoDriver(channelId: string, userId: string): boolean {
    return this.byChannel.get(channelId)?.coDrivers.delete(userId) ?? false;
  }

  coDrivers(channelId: string): string[] {
    return [...(this.byChannel.get(channelId)?.coDrivers ?? [])];
  }

  start(input: LiveSessionStart): boolean {
    if (this.byChannel.has(input.channelId)) return false;
    // Cross-process/cross-surface guard: the same reservation delegate runs use, so a second
    // channel (or an existing delegate run) targeting the same project is refused rather than
    // spawning a second permissions-bypassed agent into the same working directory.
    const reservation = reserveRun(this.opts.dir, input.projectPath, process.pid, () => this.newId());
    if (!reservation) return false;
    const s: ActiveSession = {
      handle: undefined as unknown as LiveSessionHandle,
      projectPath: input.projectPath,
      starterId: input.starterId ?? "",
      // A restricted session with no owner would lock everyone out (no id can match ""), so
      // downgrade to open — the surface didn't supply an identity to gate on.
      steering: input.steering === "restricted" && !input.starterId ? "open" : (input.steering ?? "open"),
      coDrivers: new Set(),
      sink: input.sink,
      timer: setInterval(() => void this.flush(input.channelId), this.opts.throttleMs ?? DEFAULT_THROTTLE_MS),
      buf: "", msgId: undefined, dirty: false, rendering: false, closeAfterFlush: false,
      onEnded: input.onEnded,
    };
    this.byChannel.set(input.channelId, s);
    s.handle = this.startFn(
      { projectPath: input.projectPath, prompt: input.instruction, model: input.model },
      {
        onOutput: (line) => {
          s.buf += (s.buf ? "\n" : "") + line;
          s.dirty = true;
        },
        onTurnComplete: (summary) => {
          input.onTurnResult?.(summary.result);
          s.buf += (s.buf ? "\n" : "") + turnFooter(summary);
          s.dirty = true;
          s.closeAfterFlush = true;
        },
        onExit: (err) => this.teardown(input.channelId, err),
      },
      undefined,
      this.opts.idleTimeoutMs,
    );
    // The reservation was created against this process's own pid (nothing else to track before
    // the child exists); switch it to the child's real pid so pid-liveness crash recovery
    // tracks *that child*, not this process — same reasoning as RunRegistry.start().
    if (typeof s.handle.pid === "number") {
      updateReservationPid(this.opts.dir, input.projectPath, s.handle.pid);
    }
    return true;
  }

  send(channelId: string, text: string): void {
    this.byChannel.get(channelId)?.handle.send(text);
  }

  stop(channelId: string): boolean {
    const s = this.byChannel.get(channelId);
    if (!s) return false;
    s.handle.stop(); // teardown happens via onExit once the process is confirmed dead
    return true;
  }

  stopAll(): void {
    for (const [, s] of this.byChannel) s.handle.stop();
  }

  /** Immediately SIGKILLs every active session's process group — for a process-exit shutdown
   * path, where there's no time to wait for stop()'s graceful SIGTERM-then-escalate dance (the
   * setTimeout it schedules for the SIGKILL fallback would never get to fire before this
   * process itself exits, leaving the child permissions-bypassed and orphaned).
   *
   * Deliberately does NOT release the project reservation: this process is exiting right
   * after, with no way to confirm the SIGKILL above has actually landed by then — releasing
   * blind would let a relaunch start a second session on the project while the old child is
   * still alive. The next reserveRun() for it will pid-liveness-reclaim it once the killed
   * process is verifiably gone — same crash-recovery path RunRegistry.interruptAll() uses. */
  forceKillAll(): void {
    for (const [, s] of this.byChannel) {
      if (typeof s.handle.pid === "number") {
        try {
          process.kill(-s.handle.pid, "SIGKILL");
        } catch {
          // Already dead — nothing to do.
        }
      }
    }
  }

  private teardown(channelId: string, err?: Error): void {
    const s = this.byChannel.get(channelId);
    if (!s) return;
    clearInterval(s.timer);
    this.byChannel.delete(channelId);
    // Safe to release here (not in forceKillAll — see its doc comment): teardown only ever
    // runs from onExit, i.e. once the child has actually confirmed dead, same as
    // RunRegistry's free()/cancel() reasoning.
    releaseRun(this.opts.dir, s.projectPath);
    // Wait for any flush already in flight before the final flush — otherwise flushSession's
    // own rendering guard makes this a no-op and content buffered during that window is lost.
    const wait = s.inFlight ?? Promise.resolve();
    void wait.then(async () => {
      if (s.buf) s.dirty = true; // force a final flush of anything still unsent
      const delivered = await this.finalFlush(s);
      const base = err ? `Live session died: ${err.message}` : "Live session ended.";
      s.onEnded?.(delivered ? base : `${base} (last output may be incomplete — Discord kept rejecting it)`);
    });
  }

  // The interval is already cleared and the session already removed from byChannel by the
  // time teardown calls this — there's no later tick left to retry a transient send failure
  // on, so this is the only remaining chance to deliver the session's last output. Retries a
  // bounded number of times rather than indefinitely: a genuinely broken sink (revoked token,
  // deleted channel) must not hang teardown forever.
  private async finalFlush(s: ActiveSession, attempts = 5, delayMs = 500): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      await this.flushSession(s);
      if (!s.dirty) return true;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
  }

  private async flush(channelId: string): Promise<void> {
    const s = this.byChannel.get(channelId);
    if (s) await this.flushSession(s);
  }

  private flushSession(s: ActiveSession): Promise<void> {
    if (!s.dirty || s.rendering) return s.inFlight ?? Promise.resolve();
    s.rendering = true;
    s.dirty = false;
    const run = (async () => {
      try {
        while (s.buf.length > MSG_LIMIT) {
          const cut = s.buf.lastIndexOf("\n", MSG_LIMIT);
          const at = cut > 0 ? cut : MSG_LIMIT;
          const head = s.buf.slice(0, at);
          if (s.msgId !== undefined) {
            await s.sink.edit(s.msgId, head);
            s.msgId = undefined;
          } else {
            await s.sink.post(head);
          }
          // Re-slice from s.buf (not a pre-await snapshot) after the send succeeds: new
          // output can be appended (the agent is still streaming) while this await is in
          // flight, and `at` — a fixed offset from the start — still correctly excludes
          // exactly what was just sent regardless of what's since been appended past it.
          s.buf = s.buf.slice(at).replace(/^\n/, "");
        }
        if (s.buf) {
          // s.buf holds the CURRENT message's full cumulative content — every tick resends
          // it whole (post the first time, edit thereafter), so it must NOT be truncated
          // after an ordinary send; only closeAfterFlush below ever resets it, and only to
          // what's left over after this specific send.
          const sentLength = s.buf.length;
          if (s.msgId !== undefined) await s.sink.edit(s.msgId, s.buf);
          else s.msgId = await s.sink.post(s.buf);
          if (s.closeAfterFlush) {
            s.closeAfterFlush = false;
            s.msgId = undefined;
            // Drop only what was actually sent — output appended during this await (the
            // next turn starting early) must survive as the start of the next message,
            // not be wiped by a blind reset to "".
            s.buf = s.buf.slice(sentLength).replace(/^\n/, "");
          }
        } else if (s.closeAfterFlush) {
          // Nothing queued to send this tick, but the turn still needs closing out.
          s.closeAfterFlush = false;
          s.msgId = undefined;
        }
      } catch {
        // Rate limit or transient send failure: buffer is the source of truth — retry next tick.
        s.dirty = true;
      } finally {
        s.rendering = false;
      }
    })();
    s.inFlight = run;
    return run;
  }
}
