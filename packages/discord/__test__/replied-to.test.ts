import { expect, test, vi } from "vitest";
import { refText, resolveRepliedTo, type RefMessage } from "../src/replied-to.js";

const BOT = "bot";
const m = (o: Partial<RefMessage> = {}): RefMessage =>
  ({ authorId: BOT, fromName: "Bean", content: "", embeds: [], attachments: [], at: 1000, ...o });

function deps(msgs: Record<string, RefMessage>, groups: Record<string, string[]> = {}) {
  const fetch = vi.fn(async (id: string) => {
    const msg = msgs[id];
    if (!msg) throw new Error("Unknown Message");
    return msg;
  });
  const group = (id: string) => {
    const ids = Object.values(groups).find((g) => g.includes(id));
    return ids ? { ids, index: ids.indexOf(id) } : undefined;
  };
  return { channelId: "c1", botId: BOT, fetch, groups: { group } };
}

test("no reference is no context", async () => {
  expect(await resolveRepliedTo(undefined, deps({}))).toBeUndefined();
});

test("a reply to a 3-chunk digest stitches all chunks in order", async () => {
  const d = deps({ a: m({ content: "one" }), b: m({ content: "two" }), c: m({ content: "three" }) }, { g: ["a", "b", "c"] });
  expect(await resolveRepliedTo({ channelId: "c1", messageId: "c" }, d))
    .toEqual({ fromName: "Bean", byBean: true, at: 1000, text: "one\ntwo\nthree" });
});

test("the cap keeps the referenced chunk and its nearest siblings, marked truncated", async () => {
  const big = (c: string) => m({ content: c.repeat(1990) });
  const d = deps({ a: big("a"), b: big("b"), c: big("c"), d: big("d") }, { g: ["a", "b", "c", "d"] });
  const r = await resolveRepliedTo({ channelId: "c1", messageId: "d" }, d);
  expect(r?.truncated).toBe(true);
  expect(r?.text).toBe([big("b").content, big("c").content, big("d").content].join("\n"));
});

test("a missing or foreign sibling stops that side and marks it truncated", async () => {
  const d = deps({ b: m({ content: "two" }), c: m({ content: "three", authorId: "mallory" }) }, { g: ["a", "b", "c"] });
  expect(await resolveRepliedTo({ channelId: "c1", messageId: "b" }, d))
    .toEqual({ fromName: "Bean", byBean: true, at: 1000, text: "two", truncated: true });
});

test("a person's message carries its author and isn't stitched", async () => {
  const d = deps({ x: m({ authorId: "u1", fromName: "Alice", content: "lunch?" }) }, { g: ["x", "y"] });
  expect(await resolveRepliedTo({ channelId: "c1", messageId: "x" }, d))
    .toEqual({ fromName: "Alice", byBean: false, at: 1000, text: "lunch?" });
});

test("cross-channel, deleted and empty references are unavailable", async () => {
  const d = deps({ e: m({ content: "" }), x: m({ content: "hi" }) });
  expect((await resolveRepliedTo({ channelId: "other", messageId: "x" }, d))?.unavailable).toBe(true);
  expect((await resolveRepliedTo({ channelId: "c1", messageId: "gone" }, d))?.unavailable).toBe(true);
  expect((await resolveRepliedTo({ channelId: "c1", messageId: "e" }, d))?.unavailable).toBe(true);
  expect(d.fetch).not.toHaveBeenCalledWith("x");
});

test("a forward uses its snapshot text without fetching", async () => {
  const d = deps({});
  const r = await resolveRepliedTo({ channelId: "c1", forward: m({ authorId: undefined, content: "fwd" }) }, d);
  expect(r).toMatchObject({ byBean: false, text: "fwd" });
  expect(d.fetch).not.toHaveBeenCalled();
});

test("refText falls back to embeds and lists attachments", () => {
  expect(refText(m({
    embeds: [{ title: "Digest", description: "body", fields: [{ name: "PRs", value: "3" }] }],
    attachments: [{ name: "a.png" }],
  }))).toBe("Digest\nbody\nPRs: 3\n[attachment: a.png]");
});
