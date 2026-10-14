import type { OutboxMessage } from "@bean/core";
import { chunkText } from "./chunk.js";

export interface DmUser {
  send(text: string): Promise<{ channelId: string }>;
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
  },
): Promise<string> {
  const user = await deps.fetchUser(msg.userId ?? deps.ownerId);
  // The DM channel id is only learned from a sent message — capture it rather than resolving it up front.
  let dmChannelId = "";
  for (const chunk of chunkText(text)) dmChannelId = (await user.send(chunk)).channelId;
  return dmChannelId;
}
