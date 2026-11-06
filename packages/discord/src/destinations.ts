import type { DestinationKey, SeenDestination } from "@bean/core";
import { ChannelType, PermissionFlagsBits } from "discord.js";

/** The bits of a discord.js channel read here (structural, so tests pass plain objects). */
export interface ChannelLike {
  id: string;
  type: ChannelType;
  name?: string | null;
  guild?: { name: string; members: { me: unknown } };
  permissionsFor?(member: unknown): { has(permissions: bigint[]): boolean } | null;
}

export interface DestinationStore {
  record(seen: SeenDestination): unknown;
  forget(key: DestinationKey): unknown;
}

const LISTED = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const POSTABLE = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

/** A channel as a destination: a DM is named after the other person (`dmName`), guild channels
 * `#name`; the guild is the parent. Threads aren't destinations: every top-level mention and live
 * session opens one, so they would flood the list with throwaway rows. Nor are other types. */
export function discordDestination(channel: ChannelLike, dmName?: string): SeenDestination | undefined {
  const base = { surface: "discord", conversationId: channel.id } as const;
  if (channel.type === ChannelType.DM) return { ...base, kind: "dm", platformName: dmName };
  const parentName = channel.guild?.name;
  if (LISTED.has(channel.type)) return { ...base, kind: "channel", platformName: channel.name ? `#${channel.name}` : undefined, parentName };
  return undefined;
}

export interface DiscordDestinations {
  /** Addressed ingress or a delivered outbox message. */
  seen(channel: ChannelLike, dmName?: string): void;
  /** Guild listing (`ready`, `channelCreate/Update`): a text/announcement channel is recorded while
   * Bean can view and post in it, forgotten otherwise. */
  sync(channel: ChannelLike): void;
  /** `channelDelete`: forgotten, unless the owner named it (the store keeps aliased rows). */
  removed(channel: ChannelLike): void;
}

/** Every call is wrapped: a store failure is logged, never fails a turn or a delivery (a thrown
 * delivery would be retried — a second copy of a message already sent). */
export function discordDestinations(store: DestinationStore): DiscordDestinations {
  const safe = (fn: () => unknown): void => {
    try {
      fn();
    } catch (err) {
      console.warn("discord: couldn't update a destination:", err instanceof Error ? err.message : err);
    }
  };
  const forget = (channel: ChannelLike): void => safe(() => store.forget({ surface: "discord", conversationId: channel.id }));
  return {
    seen(channel, dmName) {
      const seen = discordDestination(channel, dmName);
      if (seen) safe(() => store.record(seen));
    },
    sync(channel) {
      if (!LISTED.has(channel.type)) return;
      const me = channel.guild?.members.me;
      if (!me) return; // own member not cached: unknown access, so neither record nor forget
      const seen = discordDestination(channel);
      if (seen && channel.permissionsFor?.(me)?.has(POSTABLE)) safe(() => store.record(seen));
      else forget(channel);
    },
    removed: forget,
  };
}
