import type { ChunkGroups } from "@bean/core";

/** Split text for Discord's 2000-char message limit: greedy on line boundaries,
 * hard-splitting any single line that alone exceeds the limit. Lossless under join("\n")
 * except that hard-split segments of one line are rejoined without separators by the reader. */
export function chunkText(text: string, limit = 2000): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let current = "";
  const push = (): void => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      push();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();
  return chunks;
}

/** Sends `text` as Discord-sized chunks in order and returns each send's result. A text that
 * split into several chunks is recorded as one group once the last chunk is delivered, so a reply
 * to any chunk can rebuild the whole text. A failed send throws and records nothing (its retry
 * records its own set); a failed record is only logged — throwing after delivery would make the
 * outbox resend it. */
export async function sendChunks<T extends { id: string }>(
  text: string,
  send: (chunk: string) => Promise<T>,
  groups: Pick<ChunkGroups, "record">,
): Promise<T[]> {
  const sent: T[] = [];
  for (const chunk of chunkText(text)) sent.push(await send(chunk));
  if (sent.length > 1) {
    try {
      groups.record(sent.map((m) => m.id));
    } catch (err) {
      console.error("chunk group record failed:", err);
    }
  }
  return sent;
}
