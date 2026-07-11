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
