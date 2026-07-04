// Pure, node-free frontmatter helpers. Kept out of skill-library.ts (which touches node:fs) so the
// renderer can import setFrontmatter without dragging node built-ins into the browser bundle —
// see .memory/convention-core-is-electron-free.md for the same reasoning.

export function parseFrontmatter(text: string): Record<string, string> {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const out: Record<string, string> = {};
  for (const line of fm[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function parseDescription(text: string, fm: Record<string, string>): string {
  if (fm.description) return fm.description;
  const first = text
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ? first.replace(/^#+\s*/, "") : "";
}

/** Upsert (value given) or remove (value undefined) one frontmatter key, returning the new body.
 * Creates a frontmatter block if the file has none. Used to persist the enable toggle. */
export function setFrontmatter(body: string, key: string, value: string | undefined): string {
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return value === undefined ? body : `---\n${key}: ${value}\n---\n${body}`;
  const lines = m[1]!.split("\n").filter((l) => !l.startsWith(`${key}:`));
  if (value !== undefined) lines.push(`${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body.slice(m[0].length)}`;
}
