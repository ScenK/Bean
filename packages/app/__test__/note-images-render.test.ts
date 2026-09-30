import { expect, test } from "vitest";
import { resolveNoteImages, dataUrlToAttachment } from "../src/renderer/shared/note-images.js";

const A = "abcdef12-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";

test("resolveNoteImages substitutes known ids and marks unknown ones", async () => {
  const body = `intro\n![shot](bean-image:${A})\n![gone](bean-image:${B})\n![x](bean-image:not-a-uuid)`;
  const out = await resolveNoteImages(body, async (id) => (id === A ? "data:image/png;base64,AAAA" : undefined));
  expect(out).toBe(
    `intro\n![shot](data:image/png;base64,AAAA)\n![gone (missing image)](bean-image:${B})\n![x](bean-image:not-a-uuid)`,
  );
});

test("dataUrlToAttachment splits a chat thumbnail back into an attachment", () => {
  expect(dataUrlToAttachment("data:image/webp;base64,QUJD")).toEqual({ mimeType: "image/webp", data: "QUJD" });
  expect(dataUrlToAttachment("/tmp/x.png")).toBeUndefined();
});
