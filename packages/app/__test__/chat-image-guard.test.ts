import { expect, test } from "vitest";
import { imageFileGuard } from "../src/renderer/shared/chat-types.js";

test("rejects non-images and >10MB files, accepts small images", () => {
  expect(imageFileGuard("application/pdf", 100)).toMatch(/image/i);
  expect(imageFileGuard("image/png", 11 * 1024 * 1024)).toMatch(/10 ?MB/i);
  expect(imageFileGuard("image/png", 1024)).toBeNull();
  expect(imageFileGuard("image/jpeg", 10 * 1024 * 1024)).toBeNull();
});
