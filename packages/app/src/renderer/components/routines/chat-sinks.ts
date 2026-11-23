import type { RoutineChatopsSink, RoutineSinks } from "@bean/core";
import type { SinkRecipients } from "@bean/host";
import { homeDestination, type HomeDms } from "@bean/core/sprout-trigger";

const LABEL = { discord: "Discord", teams: "Teams" } as const;
const ROOM = { discord: "channel", teams: "conversation" } as const;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** No channel, user or destination name: the owner's DM. */
export const isDmSink = (c: RoutineChatopsSink): boolean => c.channel === undefined && c.user === undefined && c.alias === undefined;

/** Save-time cleanup of the chat sinks: trim ids, drop blank channel rows and exact duplicates
 * (same transport + target, a destination name included — a duplicate would double-post). Untouched entries keep their exact
 * shape. No chat sink and no Home left → the only-on-problems and verbatim rules have nothing to govern, so they go too. */
export function cleanChatSinks(sinks: RoutineSinks): RoutineSinks {
  const seen = new Set<string>();
  const chatops: RoutineChatopsSink[] = [];
  for (const c of sinks.chatops ?? []) {
    const entry = c.channel !== undefined && c.channel !== c.channel.trim() ? { ...c, channel: c.channel.trim() } : c;
    if (entry.channel === "") continue;
    const key = JSON.stringify([entry.transport, entry.channel ?? null, entry.user ?? null, entry.alias ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    chatops.push(entry);
  }
  if (chatops.length > 0) return { ...sinks, chatops };
  const { chatops: _c, ...kept } = sinks;
  // Home's owner-DM copy (#1068) still obeys them.
  if (sinks.home) return kept;
  const { chatopsOnlyOnProblems: _q, chatopsVerbatim: _v, ...rest } = kept;
  return rest;
}

/** Footer wording: each destination once, e.g. "Teams DM, 2 Teams conversations". Blank channel
 * rows (dropped on save) aren't counted. */
export function chatTargets(chatops: RoutineChatopsSink[] | undefined): string[] {
  const out: string[] = [];
  for (const t of ["discord", "teams"] as const) {
    const mine = (chatops ?? []).filter((c) => c.transport === t);
    if (mine.some(isDmSink)) out.push(`${LABEL[t]} DM`);
    const rooms = new Set(mine.flatMap((c) => (c.alias !== undefined ? [`alias:${c.alias}`] : c.channel?.trim() ? [c.channel.trim()] : []))).size;
    if (rooms > 0) out.push(plural(rooms, `${LABEL[t]} ${ROOM[t]}`));
    const users = new Set(mine.flatMap((c) => (c.user ? [c.user] : []))).size;
    if (users > 0) out.push(`${LABEL[t]} DM to ${plural(users, "user")}`);
  }
  return out;
}

/** Why the owner's DM on that bot can't be reached, from routinesSinkRecipients (counts, never
 * names — the desktop app can't look up who those ids are); undefined = reachable. */
export function dmProblem(transport: "discord" | "teams", recipients: SinkRecipients): string | undefined {
  const n = recipients[transport];
  if (n === undefined) return transport === "discord" ? "discord.json isn't set up" : "no Teams chats known yet";
  if (n === 0) return transport === "discord" ? "no ownerId in discord.json" : "no ownerId in teams.json, or you haven't DMed the bot yet";
  return undefined;
}

/** The builder review's destination list — every chat entry, not just the first per transport.
 * Home names the owner DMs its posts are copied to (#1069), and any of those that can't be reached. */
export function destinations(
  sinks: RoutineSinks, recipients: SinkRecipients | undefined, beanName = "Bean", dms?: HomeDms,
): { on: string[]; off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const transport of ["discord", "teams"] as const) {
    const label = LABEL[transport];
    const entries = (sinks.chatops ?? []).filter((c) => c.transport === transport);
    if (entries.length === 0) { off.push(`no ${label}`); continue; }
    for (const sink of entries) {
      if (sink.alias !== undefined) on.push(`${label} ${ROOM[transport]} "${sink.alias}"`);
      else if (sink.channel) on.push(`${label} ${ROOM[transport]} ${sink.channel}`);
      else if (sink.user) on.push(`${label} DM to user ${sink.user}`);
      // An owner-DM sink is folded into Home on load (#1068); only an older core still sends one.
      else on.push(`${label} DM to you`);
    }
  }
  if (sinks.note) on.push("Saved as a note on your Daily Dashboard"); else off.push("no note");
  if (sinks.notify) on.push("Desktop notification"); else off.push("no desktop notification");
  if (sinks.home) {
    on.push(`Posted to ${homeDestination(beanName, dms)}`);
    for (const t of ["discord", "teams"] as const) {
      const problem = dms?.[t] && recipients ? dmProblem(t, recipients) : undefined;
      if (problem) on.push(`${LABEL[t]} DM copy — dropped: ${problem}`);
    }
  } else off.push(`no post to your chat with ${beanName}`);
  return { on, off };
}
