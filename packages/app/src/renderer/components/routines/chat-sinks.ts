import type { RoutineChatopsSink, RoutineSinks } from "@bean/core";
import type { SinkRecipients } from "../../../ipc.js";

const LABEL = { discord: "Discord", teams: "Teams" } as const;
const ROOM = { discord: "channel", teams: "conversation" } as const;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Save-time cleanup of the chat sinks: trim ids, drop blank channel rows and exact duplicates
 * (same transport + target — a duplicate would double-post). Untouched entries keep their exact
 * shape. No chat sink left → the only-on-problems rule has nothing to govern, so it goes too. */
export function cleanChatSinks(sinks: RoutineSinks): RoutineSinks {
  const seen = new Set<string>();
  const chatops: RoutineChatopsSink[] = [];
  for (const c of sinks.chatops ?? []) {
    const entry = c.channel !== undefined && c.channel !== c.channel.trim() ? { ...c, channel: c.channel.trim() } : c;
    if (entry.channel === "") continue;
    const key = JSON.stringify([entry.transport, entry.channel ?? null, entry.user ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    chatops.push(entry);
  }
  if (chatops.length > 0) return { ...sinks, chatops };
  const { chatops: _c, chatopsOnlyOnProblems: _q, ...rest } = sinks;
  return rest;
}

/** Footer wording: each destination once, e.g. "Teams DM, 2 Teams conversations". Blank channel
 * rows (dropped on save) aren't counted. */
export function chatTargets(chatops: RoutineChatopsSink[] | undefined): string[] {
  const out: string[] = [];
  for (const t of ["discord", "teams"] as const) {
    const mine = (chatops ?? []).filter((c) => c.transport === t);
    if (mine.some((c) => c.channel === undefined && c.user === undefined)) out.push(`${LABEL[t]} DM`);
    const rooms = new Set(mine.flatMap((c) => (c.channel?.trim() ? [c.channel.trim()] : []))).size;
    if (rooms > 0) out.push(plural(rooms, `${LABEL[t]} ${ROOM[t]}`));
    const users = new Set(mine.flatMap((c) => (c.user ? [c.user] : []))).size;
    if (users > 0) out.push(`${LABEL[t]} DM to ${plural(users, "user")}`);
  }
  return out;
}

/** The builder review's destination list — every chat entry, not just the first per transport. */
export function destinations(sinks: RoutineSinks, recipients: SinkRecipients | undefined): { on: string[]; off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const transport of ["discord", "teams"] as const) {
    const label = LABEL[transport];
    const entries = (sinks.chatops ?? []).filter((c) => c.transport === transport);
    if (entries.length === 0) { off.push(`no ${label}`); continue; }
    for (const sink of entries) {
      if (sink.channel) { on.push(`${label} ${ROOM[transport]} ${sink.channel}`); continue; }
      if (sink.user) { on.push(`${label} DM to user ${sink.user}`); continue; }
      const n = recipients?.[transport];
      // Counts, never names — the desktop app can't look up who those ids are.
      on.push(n === undefined
        ? `${label} DM — ${transport === "discord" ? "discord.json isn't set up" : "no Teams chats known yet"}`
        : n === 0
          ? `${label} DM — dropped: ${transport === "discord" ? "no ownerId in discord.json" : "no ownerId in teams.json, or you haven't DMed the bot yet"}`
          : `${label} DM to you`);
    }
  }
  if (sinks.note) on.push("Saved as a note on your Daily Dashboard"); else off.push("no note");
  if (sinks.notify) on.push("Desktop notification"); else off.push("no desktop notification");
  return { on, off };
}
