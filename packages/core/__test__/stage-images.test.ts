import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageImages, MAX_STAGED_IMAGE_BYTES } from "../src/stage-images.js";

const png = { data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" };

describe("stageImages", () => {
  it("writes each image under a random name with its extension, dir 0700, files 0600", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bean-stage-")), "staged");
    const paths = await stageImages([png, { ...png, mimeType: "image/jpeg" }, { ...png, mimeType: "image/webp" }], dir);
    expect(paths.map((p) => p.slice(p.lastIndexOf(".")))).toEqual([".png", ".jpg", ".webp"]);
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) {
      expect(p.startsWith(`${dir}/`)).toBe(true);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(readFileSync(p, "utf8")).toBe("png-bytes");
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects a bad mime, an oversize payload and too many images before writing anything", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bean-stage-")), "staged");
    await expect(stageImages([{ ...png, mimeType: "image/gif" }], dir)).rejects.toThrow(/PNG, JPEG and WebP/);
    await expect(stageImages([{ ...png, mimeType: "constructor" }], dir)).rejects.toThrow(/PNG, JPEG and WebP/);
    await expect(stageImages([png, { ...png, data: "A".repeat(Math.ceil(MAX_STAGED_IMAGE_BYTES / 3) * 4 + 4) }], dir)).rejects.toThrow(/10 MB/);
    await expect(stageImages([png, png, png, png, png], dir)).rejects.toThrow(/at most 4/);
    expect(() => statSync(dir)).toThrow();
  });
});
