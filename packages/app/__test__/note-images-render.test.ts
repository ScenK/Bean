import { expect, test } from "vitest";
import { resolveNoteImages, dataUrlToAttachment, labelNoteImages } from "../src/renderer/shared/note-images.js";

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

test("labelNoteImages labels the first `cap` distinct ids once each, keeping failed and over-cap refs", async () => {
  const id = (n: number): string => `0000000${n}-2222-4333-8444-555555555555`;
  const body = `![a](bean-image:${id(1)}) ![b](bean-image:${id(2)}) ![a again](bean-image:${id(1)})\n`
    + `![c](bean-image:${id(3)}) ![d](bean-image:${id(4)}) ![e](bean-image:${id(5)}) ![x](bean-image:nope)`;
  const asked: string[] = [];
  let n = 0;
  const out = await labelNoteImages(body, 3, async (i) => {
    asked.push(i);
    return i === id(2) ? undefined : `[Image #${++n}]`;
  });
  expect(asked).toEqual([id(1), id(2), id(3)]);
  expect(out).toEqual({
    text: `[Image #1] ![b](bean-image:${id(2)}) [Image #1]\n`
      + `[Image #2] ![d](bean-image:${id(4)}) ![e](bean-image:${id(5)}) ![x](bean-image:nope)`,
    failed: 1,
    over: 2,
  });
});

test("labelNoteImages leaves a body without images untouched", async () => {
  expect(await labelNoteImages("plain", 4, async () => "[Image #1]")).toEqual({ text: "plain", failed: 0, over: 0 });
});
