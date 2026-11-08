import { expect, test } from "vitest";
import { formatSize, imageFileGuard, pdfFileGuard } from "../src/renderer/shared/chat-types.js";

test("rejects non-images, unsupported formats, >10MB files, and over-count; accepts supported images", () => {
  expect(imageFileGuard("application/pdf", 100)).toMatch(/image/i);
  // image/* but not a vision-supported raster format — must be rejected up front,
  // otherwise the turn fails later at the OpenAI API. GIF deliberately unsupported
  // (vision rejects animated GIFs; telling animated from static isn't worth it).
  expect(imageFileGuard("image/heic", 100)).toMatch(/PNG, JPEG, or WebP/);
  expect(imageFileGuard("image/svg+xml", 100)).toMatch(/PNG, JPEG, or WebP/);
  expect(imageFileGuard("image/gif", 1024)).toMatch(/PNG, JPEG, or WebP/);
  expect(imageFileGuard("image/png", 11 * 1024 * 1024)).toMatch(/10 ?MB/i);
  expect(imageFileGuard("image/png", 1024)).toBeNull();
  expect(imageFileGuard("image/jpeg", 10 * 1024 * 1024)).toBeNull();
  expect(imageFileGuard("image/webp", 1024)).toBeNull();
  // Aggregate cap: 4 already attached → a 5th is rejected.
  expect(imageFileGuard("image/png", 1024, 4)).toMatch(/4 images/);
  expect(imageFileGuard("image/png", 1024, 3)).toBeNull();
});

test("PDF guard: ≤ 10 MB, one per drop; chip sizes read in KB/MB", () => {
  expect(pdfFileGuard(10 * 1024 * 1024)).toBeNull();
  expect(pdfFileGuard(10 * 1024 * 1024 + 1)).toMatch(/10 MB/);
  expect(pdfFileGuard(100, 2)).toMatch(/one PDF/);
  expect(formatSize(300)).toBe("1 KB");
  expect(formatSize(820 * 1024)).toBe("820 KB");
  expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
});
