import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_IMAGES_PER_MESSAGE, SUPPORTED_IMAGE_MIMES, type ImageAttachment } from "./converse.js";

export const MAX_STAGED_IMAGE_BYTES = 10 * 1024 * 1024;
const EXT: Record<(typeof SUPPORTED_IMAGE_MIMES)[number], string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

/** Throws unless `images` is a list of at most MAX_IMAGES_PER_MESSAGE PNG/JPEG/WebP attachments,
 * each within 10 MB by base64 length (checked before decoding). The main-side trust boundary for
 * renderer-sent chat images: staging and the desktop chat handler both run it. */
export function checkImageAttachments(images: unknown): asserts images is ImageAttachment[] {
  if (!Array.isArray(images)) throw new Error("images must be a list");
  if (images.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`at most ${MAX_IMAGES_PER_MESSAGE} images per message`);
  for (const img of images as Array<Partial<ImageAttachment> | null | undefined>) {
    if (!Object.hasOwn(EXT, String(img?.mimeType))) throw new Error("only PNG, JPEG and WebP images are supported");
    if (typeof img?.data !== "string" || img.data.length > Math.ceil(MAX_STAGED_IMAGE_BYTES / 3) * 4) {
      throw new Error("image is larger than 10 MB");
    }
  }
}

/** Writes chat images to `dir` for an agent CLI to read by path: dir 0700, each file 0600 under a
 * random name with its format's extension, exclusive create. Every image is checked
 * (checkImageAttachments) before anything is written. Returns the absolute paths in order. */
export async function stageImages(images: ImageAttachment[], dir: string): Promise<string[]> {
  checkImageAttachments(images);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700); // mkdir's mode is skipped for an existing dir
  const paths: string[] = [];
  for (const img of images) {
    const bytes = Buffer.from(img.data, "base64");
    if (bytes.byteLength > MAX_STAGED_IMAGE_BYTES) throw new Error("image is larger than 10 MB");
    const path = join(dir, `${randomUUID()}${EXT[img.mimeType as keyof typeof EXT]}`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    paths.push(path);
  }
  return paths;
}
