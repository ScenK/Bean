import type { ChunkGroups, RepliedMessage } from "@bean/core";

/** The parts of a Discord message (or forward snapshot) the replied-to context reads. */
export interface RefMessage {
  authorId?: string;
  fromName: string;
  content: string;
  embeds: { title?: string | null; description?: string | null; fields?: { name: string; value: string }[] }[];
  attachments: { name: string }[];
  at: number;
}

// The stitched text's cap; the referenced chunk is always kept. ~3 full Discord chunks.
const MAX_CHARS = 6000;
// Sibling fetches per reply — bounds the Discord API calls a single reply can cost.
const MAX_SIBLING_FETCHES = 4;
const UNAVAILABLE: RepliedMessage = { fromName: "", byBean: false, text: "", at: 0, unavailable: true };

/** `content`, else the embeds' title/description/fields, plus `[attachment: name]` lines. */
export function refText(m: Pick<RefMessage, "content" | "embeds" | "attachments">): string {
  const body = m.content.trim() || m.embeds.flatMap((e) => [
    e.title ?? "", e.description ?? "", ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`),
  ]).filter((s) => s.trim()).join("\n");
  return [body, ...m.attachments.map((a) => `[attachment: ${a.name}]`)].filter(Boolean).join("\n");
}

/** Resolves what a Discord message replies to (or forwards) into core's `repliedTo`. Never throws:
 * a reference to another channel, an unreadable/deleted one, or one with no text gives
 * `{ unavailable: true }` so the turn still runs. A Bean-authored chunk is stitched back with its
 * recorded siblings (nearest first, contiguous, capped), each checked to be Bean's own. */
export async function resolveRepliedTo(
  ref: { channelId: string; messageId?: string; forward?: RefMessage } | undefined,
  deps: {
    channelId: string;
    botId: string;
    fetch: (id: string) => Promise<RefMessage>;
    groups: Pick<ChunkGroups, "group">;
  },
): Promise<RepliedMessage | undefined> {
  if (!ref) return undefined;
  // A forward carries its own snapshot; its origin isn't fetched and its author is unknown.
  if (ref.forward) {
    const text = refText(ref.forward);
    return text ? { fromName: "an unknown author (forwarded)", byBean: false, text, at: ref.forward.at } : UNAVAILABLE;
  }
  if (!ref.messageId || ref.channelId !== deps.channelId) return UNAVAILABLE;
  let msg: RefMessage;
  try {
    msg = await deps.fetch(ref.messageId);
  } catch {
    return UNAVAILABLE;
  }
  const text = refText(msg);
  if (!text) return UNAVAILABLE;
  const byBean = msg.authorId === deps.botId;
  const base = { fromName: msg.fromName, byBean, at: msg.at };
  let group: ReturnType<ChunkGroups["group"]> = undefined;
  try {
    group = byBean ? deps.groups.group(ref.messageId) : undefined;
  } catch (err) {
    console.error("chunk group lookup failed:", err);
  }
  if (!group || group.index < 0 || group.ids.length < 2) return { ...base, text };

  // Grow a contiguous window around the referenced chunk, nearest first, alternating sides. A side
  // closes on a missing/foreign sibling or the cap; any chunk left out marks the text truncated.
  const parts = new Map<number, string>([[group.index, text]]);
  let lo = group.index, hi = group.index, size = text.length, fetches = 0;
  let leftOpen = lo > 0, rightOpen = hi < group.ids.length - 1;
  const grow = async (i: number): Promise<boolean> => {
    if (fetches >= MAX_SIBLING_FETCHES) return false;
    fetches++;
    try {
      const sib = await deps.fetch(group.ids[i]!);
      const t = refText(sib);
      if (sib.authorId !== deps.botId || !t || size + 1 + t.length > MAX_CHARS) return false;
      parts.set(i, t);
      size += 1 + t.length;
      return true;
    } catch {
      return false;
    }
  };
  while (leftOpen || rightOpen) {
    if (leftOpen) { if (await grow(lo - 1)) lo--; else leftOpen = false; leftOpen &&= lo > 0; }
    if (rightOpen) { if (await grow(hi + 1)) hi++; else rightOpen = false; rightOpen &&= hi < group.ids.length - 1; }
  }
  const stitched = [...parts.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).join("\n");
  const truncated = lo > 0 || hi < group.ids.length - 1;
  return { ...base, text: stitched, ...(truncated ? { truncated: true } : {}) };
}
