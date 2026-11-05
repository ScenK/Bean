import type { SeenDestination } from "@bean/core";
import type { ConversationReference } from "botbuilder";
import { bareChannelId, isDirect } from "./proactive.js";

/** The bits of a Teams activity's `channelData` that name a conversation. A stored
 * ConversationReference drops channelData, so only addressed ingress carries them. */
export interface TeamsChannelData {
  channel?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
  meeting?: { id?: string };
}

/** What a ref (plus the activity's channelData, when there is one) says about its conversation.
 * Channels are keyed by the bare channel id; a targeted `/` pick's `a:` id isn't the shared
 * chat's, so it isn't a destination. A real DM is named after the other person. */
export function teamsDestination(
  ref: Partial<ConversationReference>, channelData?: TeamsChannelData,
): SeenDestination | undefined {
  const c = ref.conversation;
  if (!c?.id) return undefined;
  if (c.conversationType === "personal") {
    return isDirect(ref) ? { surface: "teams", conversationId: c.id, kind: "dm", platformName: ref.user?.name } : undefined;
  }
  if (c.conversationType === "channel") {
    const ch = channelData?.channel;
    const team = channelData?.team;
    // Teams sends no name for a team's General channel, whose id is the team's own.
    const general = ch?.id && ch.id === team?.id ? "General" : undefined;
    return { surface: "teams", conversationId: bareChannelId(c.id), kind: "channel", platformName: ch?.name ?? general, parentName: team?.name };
  }
  return { surface: "teams", conversationId: c.id, kind: c.id.startsWith("19:meeting_") ? "meeting" : "group", platformName: c.name };
}

export interface TeamsDestinationRecorder {
  /** Addressed ingress. A meeting's title is fetched once per meeting id (awaited — call it while
   * the turn context is live). Never throws. */
  seen(ref: Partial<ConversationReference>, channelData: TeamsChannelData | undefined, meetingTitle: (meetingId: string) => Promise<string | undefined>): Promise<void>;
  /** After a successful outbox post — the ref alone, so known names are kept. Never throws. */
  delivered(ref: Partial<ConversationReference>): void;
}

/** Wraps `record` so a failure is logged and never fails the turn or the delivery (a thrown
 * delivery would be retried — a second copy of a message already sent). */
export function teamsDestinationRecorder(record: (seen: SeenDestination) => unknown): TeamsDestinationRecorder {
  const safe = (seen: SeenDestination | undefined): void => {
    if (!seen) return;
    try {
      record(seen);
    } catch (err) {
      console.warn("teams: couldn't record a destination:", err instanceof Error ? err.message : err);
    }
  };
  const meetings = new Set<string>();
  return {
    async seen(ref, channelData, meetingTitle) {
      const seen = teamsDestination(ref, channelData);
      safe(seen);
      const id = channelData?.meeting?.id;
      if (seen?.kind !== "meeting" || !id || meetings.has(id)) return;
      meetings.add(id);
      try {
        const title = await meetingTitle(id);
        if (title) safe({ ...seen, platformName: title });
      } catch (err) {
        console.warn("teams: couldn't fetch a meeting title:", err instanceof Error ? err.message : err);
      }
    },
    delivered: (ref) => safe(teamsDestination(ref)),
  };
}
