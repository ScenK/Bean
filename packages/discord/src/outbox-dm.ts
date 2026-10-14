import type { OutboxMessage } from "@bean/core";
import { chunkText } from "./chunk.js";

export interface DmUser {
  username: string;
  send(text: string): Promise<{ channelId: string }>;
}

/** Delivers a channel-less outbox message as a DM to `msg.userId ?? ownerId`. Returns the DM
 * channel id (the conversation id) on success. A failed DM to a non-owner queues one owner
 * notice via `notifyOwner` (which has no userId, so its own failure can't loop); no retry. */
export async function deliverOutboxDm(
  msg: OutboxMessage,
  text: string,
  deps: {
    ownerId: string;
    fetchUser: (id: string) => Promise<DmUser>;
    notifyOwner: (body: string) => Promise<unknown>;
  },
): Promise<string | undefined> {
  const userId = msg.userId ?? deps.ownerId;
  let name = userId;
  try {
    const user = await deps.fetchUser(userId);
    name = user.username;
    // The DM channel id is only learned from a sent message — capture it rather than resolving it up front.
    let dmChannelId: string | undefined;
    for (const chunk of chunkText(text)) dmChannelId = (await user.send(chunk)).channelId;
    return dmChannelId;
  } catch (err) {
    console.error(`outbox: discord DM to ${userId} failed`, err);
    if (userId !== deps.ownerId) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.notifyOwner(`Couldn't DM ${name}${msg.title ? ` "${msg.title}"` : ""}: ${reason}`)
        .catch((e: unknown) => console.error("outbox: owner notice failed", e));
    }
    return undefined;
  }
}
