import { useEffect, useState } from "preact/hooks";
import type { ImageAttachment } from "@bean/core";

// Renderer side of note images (core note-images.ts): a note body references a stored image as
// `![alt](bean-image:<uuid>)`. Before rendering, each ref is swapped for the data: URL main
// builds from the note_images row, so Markdown's sanitizer (which only admits inline raster
// data: images) never needs loosening. Can't import core values here (node-free bundle rule).
const NEEDLE = "](bean-image:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Substitutes known ids with their data: URL; an unknown id keeps its ref (the sanitizer then
 * drops it to its alt text) with a "(missing image)" marker added to the alt. Linear indexOf scan. */
export async function resolveNoteImages(body: string, lookup: (id: string) => Promise<string | undefined>): Promise<string> {
  let out = "";
  let from = 0;
  for (let i = body.indexOf(NEEDLE); i !== -1; i = body.indexOf(NEEDLE, i + NEEDLE.length)) {
    const start = i + NEEDLE.length;
    const id = body.slice(start, start + 36);
    if (body[start + 36] !== ")" || !UUID.test(id)) continue;
    const url = await lookup(id);
    out += body.slice(from, i) + (url ? `](${url})` : ` (missing image)${NEEDLE}${id})`);
    from = start + 37;
  }
  return out + body.slice(from);
}

const REF = /!\[[^\]\n]*\]\(bean-image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/g;

/** A note handed to a live agent (#950): the first `cap` distinct image ids, in body order, are
 * passed to `label` one at a time (it stages the image and returns its `[Image #N]`), and every
 * ref to a labelled id becomes that label. An id `label` can't attach (undefined) keeps its ref and
 * counts as `failed`; distinct ids past the cap keep theirs and count as `over`. */
export async function labelNoteImages(
  body: string, cap: number, label: (id: string) => Promise<string | undefined>,
): Promise<{ text: string; failed: number; over: number }> {
  const ids = [...new Set(Array.from(body.matchAll(REF), (m) => m[1]!))];
  const labels = new Map<string, string>();
  let failed = 0;
  for (const id of ids.slice(0, cap)) {
    const l = await label(id);
    if (l) labels.set(id, l);
    else failed++;
  }
  const text = body.replace(REF, (ref, id: string) => labels.get(id) ?? ref);
  return { text, failed, over: Math.max(0, ids.length - cap) };
}

const cache = new Map<string, Promise<string | undefined>>();
// ponytail: unbounded per-window cache of data URLs; rows are immutable so it never goes stale —
// add LRU eviction if people browse hundreds of image-heavy notes in one window.
const lookupCached = (id: string): Promise<string | undefined> => {
  let p = cache.get(id);
  if (!p) {
    p = window.bean.noteImage(id).catch(() => undefined);
    cache.set(id, p);
  }
  return p;
};

/** `body` with its bean-image refs resolved; the raw body until resolution finishes. */
export function useResolvedNoteBody(body: string): string {
  const [resolved, setResolved] = useState(body);
  useEffect(() => {
    let live = true;
    setResolved(body);
    if (body.includes(NEEDLE)) void resolveNoteImages(body, lookupCached).then((b) => { if (live) setResolved(b); });
    return () => { live = false; };
  }, [body]);
  return resolved;
}

/** Stores pasted/dropped image files (via main's byte-only IPC) and returns the markdown refs to
 * insert, plus the first guard error for any rejected file. */
export async function storeNoteImageFiles(
  files: File[],
  guard: (type: string, size: number) => string | null,
): Promise<{ refs: string[]; error?: string }> {
  const refs: string[] = [];
  let error: string | undefined;
  for (const f of files) {
    const problem = guard(f.type, f.size);
    if (problem) { error ??= problem; continue; }
    try {
      refs.push(`![image](bean-image:${await window.bean.saveNoteImage(new Uint8Array(await f.arrayBuffer()))})`);
    } catch (err) {
      error ??= err instanceof Error ? err.message : String(err);
    }
  }
  return { refs, error };
}

/** A chat thumbnail's `data:<mime>;base64,<data>` URL back into an attachment. */
export function dataUrlToAttachment(url: string): ImageAttachment | undefined {
  const m = /^data:([^;,]+);base64,/.exec(url);
  return m ? { mimeType: m[1]!, data: url.slice(m[0].length) } : undefined;
}
