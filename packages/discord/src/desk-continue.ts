import { ChannelType, PermissionFlagsBits, ThreadAutoArchiveDuration, type MessageCreateOptions } from "discord.js";

/** The slice of a fetched channel `openContinueThread` reads (a discord.js GuildText channel fits). */
export interface ThreadHome<T> {
  type: ChannelType;
  permissionsFor(user: { id: string }): { has(perms: bigint[]): boolean } | null;
  threads: { create(o: { name: string; autoArchiveDuration: ThreadAutoArchiveDuration }): Promise<T> };
}

/** Opens a desk-continue thread (#695). Unlike `/live-session` there is no channel fallback: any
 * channel that isn't a text channel where Bean may open public threads and post in them throws. */
export async function openContinueThread<T>(
  channel: ThreadHome<T> | { type: ChannelType } | null, me: { id: string } | null, title: string,
): Promise<T> {
  if (!channel || channel.type !== ChannelType.GuildText || !("threads" in channel) || !me) throw new Error("not a text channel");
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads])) {
    throw new Error("missing thread permissions");
  }
  return channel.threads.create({ name: title.slice(0, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
}

/** A post that can ping the owner and nobody else, whatever its text holds (`@everyone`, a role
 * or another user's mention). */
export const ownerOnly = (ownerId: string, content: string): MessageCreateOptions =>
  ({ content, allowedMentions: { users: [ownerId] } });
