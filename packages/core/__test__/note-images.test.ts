import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveNoteImage, loadNoteImage, noteImageRefs, attachNoteImages, sniffImageMime, MAX_NOTE_IMAGE_BYTES,
} from "../src/note-images.js";
import { saveNote, loadNoteHistory } from "../src/note-store.js";
import { closeDb } from "../src/db.js";
import { dbFile } from "../src/config.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-note-images-"));
  file = dbFile(dir);
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 7]);

test("sniffImageMime allowlists png/jpeg/webp by magic bytes only", () => {
  expect(sniffImageMime(PNG)).toBe("image/png");
  expect(sniffImageMime(JPEG)).toBe("image/jpeg");
  expect(sniffImageMime(WEBP)).toBe("image/webp");
  expect(sniffImageMime(new TextEncoder().encode("GIF89a..."))).toBeUndefined();
  expect(sniffImageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
  expect(sniffImageMime(new Uint8Array())).toBeUndefined();
});

test("saveNoteImage round-trips bytes + sniffed MIME under a UUID id", async () => {
  const id = await saveNoteImage(file, JPEG);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const img = await loadNoteImage(file, id);
  expect(img?.mime).toBe("image/jpeg");
  expect([...img!.bytes]).toEqual([...JPEG]);
});

test("saveNoteImage rejects a wrong magic number, SVG/GIF, and oversize images", async () => {
  await expect(saveNoteImage(file, Uint8Array.from([1, 2, 3, 4]))).rejects.toThrow(/PNG, JPEG and WebP/);
  await expect(saveNoteImage(file, new TextEncoder().encode("GIF89a"))).rejects.toThrow();
  const big = new Uint8Array(MAX_NOTE_IMAGE_BYTES + 1);
  big.set(PNG);
  await expect(saveNoteImage(file, big)).rejects.toThrow(/10 MB/);
});

test("loadNoteImage rejects non-UUID ids and misses unknown ones", async () => {
  expect(await loadNoteImage(file, "../../etc/passwd")).toBeUndefined();
  expect(await loadNoteImage(file, "' OR 1=1 --")).toBeUndefined();
  expect(await loadNoteImage(file, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
});

test("noteImageRefs finds well-formed refs only", () => {
  const a = "abcdef12-2222-4333-8444-555555555555";
  const body = `x ![a](bean-image:${a}) ![b](bean-image:nope) ![c](bean-image:${a.toUpperCase()})`;
  expect(noteImageRefs(body)).toEqual([a]);
});

test("noteImageRefs is linear on a huge adversarial body", () => {
  const body = "(bean-image:".repeat(200_000);
  const t = performance.now();
  expect(noteImageRefs(body)).toEqual([]);
  expect(performance.now() - t).toBeLessThan(500);
});

test("attachNoteImages stores each image and appends refs bound to the stored ids", async () => {
  const body = await attachNoteImages((b) => saveNoteImage(file, b), "## Summary\n\nhi\n", [
    { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
    { data: Buffer.from(WEBP).toString("base64"), mimeType: "image/jpeg" }, // declared MIME ignored
  ]);
  const ids = noteImageRefs(body);
  expect(ids).toHaveLength(2);
  expect(body).toBe(`## Summary\n\nhi\n\n![image](bean-image:${ids[0]})\n![image](bean-image:${ids[1]})\n`);
  expect((await loadNoteImage(file, ids[1]!))?.mime).toBe("image/webp");
});

test("attachNoteImages enforces the per-save count cap and rejects bad bytes", async () => {
  const one = { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" };
  await expect(attachNoteImages((b) => saveNoteImage(file, b), "b", [one, one, one, one, one])).rejects.toThrow(/at most 4/);
  await expect(attachNoteImages((b) => saveNoteImage(file, b), "b", [{ data: "aGVsbG8=", mimeType: "image/png" }])).rejects.toThrow();
});

test("note history keeps bean-image refs verbatim", async () => {
  const id = await saveNoteImage(file, PNG);
  const body = `![shot](bean-image:${id})`;
  const slug = await saveNote(file, { title: "Pics", body });
  await saveNote(file, { title: "Pics", body: "text only", slug });
  const [v1] = await loadNoteHistory(file, slug);
  expect(v1!.body).toBe(body);
  expect(await loadNoteImage(file, id)).toBeDefined();
});
