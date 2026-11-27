import type { ChunkGroups } from "@bean/core";
import { type Fence, fenceAfter, renderTables } from "./tables.js";

/** Split text for Discord's 2000-char message limit: greedy on line boundaries,
 * hard-splitting any single line that alone exceeds the limit. A split inside a fenced code block
 * closes the fence at the end of the chunk and reopens it (same opening line) at the start of the
 * next, so the next message isn't inverted. Lossless under join("\n") minus those added fences,
 * except that hard-split segments of one line are rejoined without separators by the reader. */
export function chunkText(text: string, limit = 2000): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let cur: string[] = [];
  let fence: Fence | undefined; // open after cur's last line
  let openAt = -1; // cur index of that fence's opening line
  let carried = false; // cur is only the reopen line a split added
  const fits = (lines: string[], f: Fence | undefined): boolean =>
    lines.join("\n").length + (f ? f.marker.length + 1 : 0) <= limit;
  const flush = (): void => {
    // Never end a chunk on a bare opening line: the reopen in the next chunk replaces it.
    if (fence && openAt === cur.length - 1) cur.pop();
    if (cur.length) chunks.push((fence ? [...cur, fence.marker] : cur).join("\n"));
    cur = fence ? [fence.line] : [];
    openAt = fence ? 0 : -1;
    carried = !!fence;
  };
  for (const line of text.split("\n")) {
    const after = fenceAfter(line, fence);
    if (carried && !after) {
      // The fence closes right after a split: the closer the split added stands in for this one.
      cur = [];
      fence = undefined;
      carried = false;
      continue;
    }
    if (!fits([...cur, line], after)) {
      flush();
      if (!fits([...cur, line], after)) {
        // A line too long for any chunk: hard-split it, each piece wrapped in the open fence —
        // unless the fence's own lines leave no room, then the pieces go unwrapped.
        let head = cur.length ? `${cur[0]}\n` : "";
        let tail = fence ? `\n${fence.marker}` : "";
        let step = limit - head.length - tail.length;
        if (step < 1) [head, tail, step] = ["", "", limit];
        for (let i = 0; i < line.length; i += step) chunks.push(head + line.slice(i, i + step) + tail);
        continue;
      }
    }
    cur.push(line);
    carried = false;
    if (after && !fence) openAt = cur.length - 1;
    fence = after;
  }
  // The last chunk ends as the text does; a lone reopen line carries nothing.
  if (cur.length && !carried) chunks.push(cur.join("\n"));
  // Discord rejects a blank message (e.g. a split right before a trailing newline).
  return chunks.filter((c) => c.trim());
}

/** Sends `text` (tables rendered for a phone, see tables.ts) as Discord-sized chunks in order and returns each send's result. A text that
 * split into several chunks — or any sprout post (`sprout`, #1134), even one chunk — is recorded as
 * one group once the last chunk is delivered, so a reply to any chunk can rebuild the whole text
 * and name its sprout. A failed send throws and records nothing (its retry
 * records its own set); a failed record is only logged — throwing after delivery would make the
 * outbox resend it. */
export async function sendChunks<T extends { id: string }>(
  text: string,
  send: (chunk: string) => Promise<T>,
  groups: Pick<ChunkGroups, "record">,
  sprout?: string,
): Promise<T[]> {
  const sent: T[] = [];
  for (const chunk of chunkText(renderTables(text))) sent.push(await send(chunk));
  if (sent.length > 1 || (sprout && sent.length > 0)) {
    try {
      groups.record(sent.map((m) => m.id), sprout ? { sprout } : {});
    } catch (err) {
      console.error("chunk group record failed:", err);
    }
  }
  return sent;
}
