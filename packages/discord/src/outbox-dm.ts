import type { ChunkGroups, OutboxMessage } from "@bean/core";
import { sendChunks } from "./chunk.js";

export interface DmUser {
  send(text: string): Promise<{ channelId: string; id: string }>;
}

/** Delivers a channel-less outbox message as a DM to `msg.userId ?? ownerId`. Returns the DM
 * channel id (the conversation id). Throws on failure — the outbox drain retries, then sends the
 * owner one notice. */
export async function deliverOutboxDm(
  msg: OutboxMessage,
  text: string,
  deps: {
    ownerId: string;
    fetchUser: (id: string) => Promise<DmUser>;
    groups: Pick<ChunkGroups, "record">;
  },
): Promise<string> {
  const user = await deps.fetchUser(msg.userId ?? deps.ownerId);
  // The DM channel id is only learned from a sent message — capture it rather than resolving it up front.
  const sent = await sendChunks(text, (chunk) => user.send(chunk), deps.groups);
  return sent.at(-1)?.channelId ?? "";
}
