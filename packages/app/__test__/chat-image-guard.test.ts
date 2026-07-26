import { expect, test } from "vitest";
import { imageFileGuard } from "../src/renderer/shared/chat-types.js";

test("rejects non-images, unsupported formats, and >10MB files; accepts supported images", () => {
  expect(imageFileGuard("application/pdf", 100)).toMatch(/image/i);
  // image/* but not a vision-supported raster format — must be rejected up front,
  // otherwise the turn fails later at the OpenAI API.
  expect(imageFileGuard("image/heic", 100)).toMatch(/PNG, JPEG, GIF, or WebP/);
  expect(imageFileGuard("image/svg+xml", 100)).toMatch(/PNG, JPEG, GIF, or WebP/);
  expect(imageFileGuard("image/png", 11 * 1024 * 1024)).toMatch(/10 ?MB/i);
  expect(imageFileGuard("image/png", 1024)).toBeNull();
  expect(imageFileGuard("image/jpeg", 10 * 1024 * 1024)).toBeNull();
  expect(imageFileGuard("image/gif", 1024)).toBeNull();
  expect(imageFileGuard("image/webp", 1024)).toBeNull();
});
