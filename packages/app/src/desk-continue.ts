import { MAX_CONTINUE_TITLE, type DeskContinueBody, type DeskContinueResult, type Destination } from "@bean/core";
import { buildCarryTail, type LiveHandover, type LiveOwner } from "@bean/host";

// Continue in Discord (#697): the desktop side of desk-continue (core chatops/desk.ts, bot side #695/#696).
// The renderer names a channel, a title, and either its recent chat (plain) or its agent session;
// main checks the channel is a known Discord channel, keeps a chat to one request at a time, and for
// an agent session stops it and waits for its exit before the bot resumes it (one owner at a time).

/** What the renderer sends. `sessionId` = Bean's own id of this chat's live session (agent mode). */
export interface DeskContinueRequest { channelId: string; title: string; history?: unknown; sessionId?: string }

/** The bot's ack, or why there was none. */
export type DeskContinueReply = DeskContinueResult | { failed: string };

export interface DeskContinueDeps {
  listDestinations: () => Destination[];
  /** chatopsServers.deskContinue for the Discord bot — rejects when it isn't running or doesn't ack. */
  deskContinue: (body: DeskContinueBody) => Promise<DeskContinueResult>;
  handover: (owner: LiveOwner, sessionId: unknown) => Promise<LiveHandover>;
}

const failed = (failed: string): DeskContinueReply => ({ failed });

export function buildDeskContinueHandler(deps: DeskContinueDeps) {
  // Mounts with a request in flight: a double click sends one.
  const inFlight = new Set<string>();
  return async (owner: LiveOwner, incognito: boolean, raw: unknown): Promise<DeskContinueReply> => {
    const req = raw as Partial<DeskContinueRequest> | null;
    if (!req || typeof req.channelId !== "string" || typeof req.title !== "string") return failed("Invalid request.");
    const title = req.title.trim();
    if (!title || title.length > MAX_CONTINUE_TITLE) return failed(`The thread title needs 1–${MAX_CONTINUE_TITLE} characters.`);
    if (incognito) return failed("Off-the-record chats stay on this Mac.");
    const channel = deps.listDestinations().find((d) => d.surface === "discord" && d.kind === "channel" && d.conversationId === req.channelId);
    if (!channel) return failed("Pick a Discord channel Bean knows.");
    if (inFlight.has(owner.mountId)) return failed("This chat is already being continued.");
    inFlight.add(owner.mountId);
    try {
      if (req.sessionId !== undefined) {
        const held = await deps.handover(owner, req.sessionId);
        if ("error" in held) return failed(held.error);
        try {
          return await deps.deskContinue({ mode: "agent", channelId: channel.conversationId, title, sessionId: held.cliId });
        } finally {
          held.release();
        }
      }
      const { tail, count } = buildCarryTail(req.history);
      if (count === 0) return failed("Nothing to carry over yet.");
      return await deps.deskContinue({ mode: "chat", channelId: channel.conversationId, title, tail, count });
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.delete(owner.mountId);
    }
  };
}
