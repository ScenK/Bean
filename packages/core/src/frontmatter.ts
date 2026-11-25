// Pure, node-free frontmatter helpers. Kept out of skill-library.ts (which touches node:fs) so the
// renderer can import setFrontmatter without dragging node built-ins into the browser bundle —
// see .memory/convention-core-is-electron-free.md for the same reasoning.

export function parseFrontmatter(text: string): Record<string, string> {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const out: Record<string, string> = {};
  for (const line of fm[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Picker disclosure for a `browser: true` skill; codex's browser tools also control the computer. */
export const BROWSER_SKILL_NOTE = "🌐 uses your browser (and computer on codex)";

/** Skill proposal card disclosure (#1108): "on" while the draft's parsed frontmatter has
 * `browser: true`, "off" when a replacement drops it from an existing browser skill. Derived from
 * the body only, never from model prose — saving the body stays the only switch. */
export type SkillBrowserChange = "on" | "off";
export const SKILL_BROWSER_NOTES: Record<SkillBrowserChange, string> = {
  on: BROWSER_SKILL_NOTE,
  off: "🌐 no longer uses your browser",
};

export function skillBrowserChange(body: string, existingBrowser: boolean): SkillBrowserChange | undefined {
  if (parseFrontmatter(body).browser?.toLowerCase() === "true") return "on";
  return existingBrowser ? "off" : undefined;
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
/** The skill body without its frontmatter block — what actually goes into a composed prompt.
 * Frontmatter is Bean metadata, not instructions; leaving it in also broke opencode's arg
 * parsing (a prompt starting with `---` looks like a flag to yargs). */
export function stripFrontmatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Auto-formatter applied when a skill is saved: whitespace cleanup only. Deliberately does
 * NOT inject `target:` or any other tag — where a skill runs is the user's call (Bean can't
 * know if their machine/skill suits a terminal run), so the UI requires `target:` at save
 * time instead of silently defaulting it. */
export function formatSkillBody(body: string): string {
  return `${body.trim()}\n`;
}

export function setFrontmatter(body: string, key: string, value: string | undefined): string {
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return value === undefined ? body : `---\n${key}: ${value}\n---\n${body}`;
  const lines = m[1]!.split("\n").filter((l) => !l.startsWith(`${key}:`));
  if (value !== undefined) lines.push(`${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body.slice(m[0].length)}`;
}
