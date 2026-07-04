import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/** A saved note: conversation output parked for later. Unlike memories, notes are never
 * injected into prompts — they do nothing until the user explicitly continues one in chat. */
export interface Note {
  /** Stable id derived from filename without extension. */
  slug: string;
  title: string;
  /** Markdown body below the frontmatter block. */
  body: string;
  /** Project path this note belongs to; absent = general. */
  project?: string;
  /** ISO timestamp of the last save. */
  updated: string;
  version: number;
  source: "chat" | "manual";
  /** Unchecked `- [ ]` items in the body — the "open questions" count. */
  openCount: number;
}

export interface NoteDraft {
  title: string;
  body: string;
  project?: string;
  source?: "chat" | "manual";
  /** Present = update that note in place (version bump, prior version kept in .history/). */
  slug?: string;
}

export function openQuestionCount(body: string): number {
  return (body.match(/^\s*[-*] \[ \]/gm) ?? []).length;
}

function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "note";
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

const traversal = /[/\\]|\.\./;

export async function loadNotes(dir: string): Promise<Note[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const notes: Note[] = [];
  for (const file of entries.filter((f) => f.endsWith(".md")).sort()) {
    const raw = await readFile(join(dir, file), "utf8");
    const fm = parseFrontmatter(raw);
    const body = stripFrontmatter(raw);
    notes.push({
      slug: basename(file, ".md"),
      title: fm.title || basename(file, ".md"),
      body,
      project: fm.project || undefined,
      updated: fm.updated ?? "",
      version: Number(fm.version) >= 1 ? Number(fm.version) : 1,
      source: fm.source === "manual" ? "manual" : "chat",
      openCount: openQuestionCount(body),
    });
  }
  // Most recently updated first.
  return notes.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Create (no slug) or update-in-place (slug given). On update the prior file is copied to
 * .history/<slug>.v<n>.md first — updates are never destructive. Returns the saved note's slug. */
export async function saveNote(
  dir: string,
  draft: NoteDraft,
  now: () => Date = () => new Date(),
): Promise<string> {
  if (draft.slug !== undefined && traversal.test(draft.slug)) throw new Error(`invalid note slug: ${draft.slug}`);
  if (!draft.title.trim()) throw new Error("note title is required");
  await mkdir(dir, { recursive: true });

  let slug = draft.slug;
  let version = 1;
  if (slug) {
    const prev = join(dir, `${slug}.md`);
    try {
      const fm = parseFrontmatter(await readFile(prev, "utf8"));
      version = (Number(fm.version) >= 1 ? Number(fm.version) : 1) + 1;
      await mkdir(join(dir, ".history"), { recursive: true });
      await copyFile(prev, join(dir, ".history", `${slug}.v${version - 1}.md`));
    } catch {
      // slug given but file gone — treat as a fresh v1 create under that slug
    }
  } else {
    slug = slugify(draft.title);
    const taken = new Set((await loadNotes(dir)).map((n) => n.slug));
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(draft.title)}-${i}`;
  }

  const fmLines = [
    `title: ${draft.title.trim()}`,
    `updated: ${now().toISOString()}`,
    `version: ${version}`,
    `source: ${draft.source ?? "chat"}`,
    ...(draft.project ? [`project: ${draft.project}`] : []),
  ];
  await writeFile(join(dir, `${slug}.md`), `---\n${fmLines.join("\n")}\n---\n${draft.body}`, "utf8");
  return slug;
}

/** Removes the note file; its .history/ versions are deliberately kept. */
export async function deleteNote(dir: string, slug: string): Promise<void> {
  if (traversal.test(slug)) throw new Error(`invalid note slug: ${slug}`);
  await rm(join(dir, `${slug}.md`), { force: true });
}
