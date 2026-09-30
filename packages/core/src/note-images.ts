import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { MAX_IMAGES_PER_MESSAGE, type ImageAttachment } from "./converse.js";

/** Images embedded in notes live in bean.db's note_images table as raw BLOBs; a note body
 * references one as `![alt](bean-image:<uuid>)`. No file paths, so the note store stays one file. */
export const NOTE_IMAGE_SCHEME = "bean-image:";
export const MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024;
export type NoteImageMime = "image/png" | "image/jpeg" | "image/webp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** Format by magic bytes — the declared MIME is never trusted. Exact png/jpeg/webp allowlist
 * (SUPPORTED_IMAGE_MIMES); SVG, GIF, HEIC and everything else are undefined. */
export function sniffImageMime(b: Uint8Array): NoteImageMime | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return undefined;
}

/** Stores one image and returns its server-generated id. Throws on oversize or a format outside
 * the allowlist — this is the trust boundary for every ingest path (editor paste, chat, bots). */
export async function saveNoteImage(file: string, bytes: Uint8Array, now: () => Date = () => new Date()): Promise<string> {
  if (bytes.byteLength > MAX_NOTE_IMAGE_BYTES) throw new Error("image is larger than 10 MB");
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error("only PNG, JPEG and WebP images are supported");
  const id = randomUUID();
  openDb(file).prepare("INSERT INTO note_images (id, mime, bytes, created) VALUES (?, ?, ?, ?)")
    .run(id, mime, bytes, now().toISOString());
  return id;
}

export async function loadNoteImage(file: string, id: string): Promise<{ mime: NoteImageMime; bytes: Uint8Array } | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = openDb(file).prepare("SELECT mime, bytes FROM note_images WHERE id = ?").get(id) as
    { mime: NoteImageMime; bytes: Uint8Array } | undefined;
  return row ? { mime: row.mime, bytes: row.bytes } : undefined;
}

/** Ids referenced as `(bean-image:<id>)` in a note body. Linear indexOf scan, no regex over the
 * untrusted body (convention-new-external-surface). Only UUID-shaped ids are returned. */
export function noteImageRefs(body: string): string[] {
  const ids: string[] = [];
  const needle = `(${NOTE_IMAGE_SCHEME}`;
  for (let i = body.indexOf(needle); i !== -1; i = body.indexOf(needle, i + needle.length)) {
    const start = i + needle.length;
    const id = body.slice(start, start + 36);
    if (body[start + 36] === ")" && UUID.test(id)) ids.push(id);
  }
  return ids;
}

/** Stores chat-attached images and appends a code-written `![image](bean-image:<id>)` line per
 * image to `body` — refs are bound to real stored ids, never written by the model. Base64 size is
 * checked before decoding; the decoded bytes are re-checked by saveNoteImage. */
export async function attachNoteImages(
  save: (bytes: Uint8Array) => Promise<string>,
  body: string,
  images: ImageAttachment[],
): Promise<string> {
  if (images.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`at most ${MAX_IMAGES_PER_MESSAGE} images per note save`);
  const refs: string[] = [];
  for (const img of images) {
    if (typeof img?.data !== "string" || img.data.length > Math.ceil(MAX_NOTE_IMAGE_BYTES / 3) * 4) {
      throw new Error("image is larger than 10 MB");
    }
    refs.push(`![image](${NOTE_IMAGE_SCHEME}${await save(Buffer.from(img.data, "base64"))})`);
  }
  if (refs.length === 0) return body;
  return `${body.trimEnd()}\n\n${refs.join("\n")}\n`;
}
