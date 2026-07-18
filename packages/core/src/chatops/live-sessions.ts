import {
  startLiveSession as defaultStartLiveSession,
  type LiveSessionCallbacks, type LiveSessionHandle, type LiveSessionRequest, type TurnSummary,
} from "../live-session.js";

/** Surface-agnostic "post or edit a plain text message". Chatops builds this on top of
 * BotEffects: post = postCard({content}), edit = updateCard(id, {content}). */
export interface LiveSessionSink {
  post: (text: string) => Promise<string>;
  edit: (id: string, text: string) => Promise<void>;
}

export interface LiveSessionStart {
  channelId: string;
  projectPath: string;
  instruction: string;
  model?: string;
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

/** channelId → active live session. One session per channel; while bound, the bot routes
 * that channel's messages to the session instead of converse(). */
export class LiveSessionRegistry {
  private byChannel = new Map<string, ActiveSession>();

  constructor(
    private startFn: StartFn = defaultStartLiveSession as StartFn,
    private opts: { throttleMs?: number; idleTimeoutMs?: number } = {},
  ) {}

  has(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  start(input: LiveSessionStart): boolean {
    if (this.byChannel.has(input.channelId)) return false;
    const s: ActiveSession = {
      handle: undefined as unknown as LiveSessionHandle,
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

  private teardown(channelId: string, err?: Error): void {
    const s = this.byChannel.get(channelId);
    if (!s) return;
    clearInterval(s.timer);
    this.byChannel.delete(channelId);
    // Wait for any flush already in flight before the final flush — otherwise flushSession's
    // own rendering guard makes this a no-op and content buffered during that window is lost.
    const wait = s.inFlight ?? Promise.resolve();
    void wait.then(() => {
      if (s.buf) s.dirty = true; // force a final flush of anything still unsent
      return this.flushSession(s);
    }).then(() => {
      s.onEnded?.(err ? `Live session died: ${err.message}` : "Live session ended.");
    });
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
          const remainder = s.buf.slice(at).replace(/^\n/, "");
          if (s.msgId !== undefined) {
            await s.sink.edit(s.msgId, head);
            s.msgId = undefined;
          } else {
            await s.sink.post(head);
          }
          // Only commit the truncation once the send actually succeeded — a rejected
          // sink call above throws before this line, leaving `head` still in s.buf for retry.
          s.buf = remainder;
        }
        if (s.buf) {
          if (s.msgId !== undefined) await s.sink.edit(s.msgId, s.buf);
          else s.msgId = await s.sink.post(s.buf);
        }
        if (s.closeAfterFlush) {
          s.closeAfterFlush = false;
          s.msgId = undefined;
          s.buf = "";
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
