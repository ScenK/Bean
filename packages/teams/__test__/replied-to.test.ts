import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseQuote, type QuoteActivity } from "../src/replied-to.js";

const fixture = (name: string): QuoteActivity =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as QuoteActivity;
// What server.ts hands in: removeRecipientMention's output.
const typed = (a: QuoteActivity): string => (a.text ?? "").replace("<at>Bean</at>", "").trim();

test("group chat: the quoted Bean answer becomes repliedTo and leaves the sender's words alone", () => {
  const a = fixture("quote-reply-group");
  expect(parseQuote(a, typed(a))).toEqual({
    text: "what about Friday?",
    repliedTo: { fromName: "Bean", byBean: true, text: "The deploy window is Thursday 3-5pm & needs sign-off.", at: 1772050244572 },
  });
});

test("personal chat: an ellipsis-ended preview is marked truncated", () => {
  const a = fixture("quote-reply-personal");
  const r = parseQuote(a, typed(a));
  expect(r.text).toBe("can you shorten this?");
  expect(r.repliedTo).toMatchObject({ byBean: true, truncated: true, at: 1772050344000 });
});

test("legacy html quote: the sender's words come from outside the blockquote", () => {
  const a = fixture("quote-reply-legacy-html");
  expect(parseQuote(a, typed(a))).toEqual({
    text: "sounds good, book it",
    repliedTo: { fromName: "Alex Doe", byBean: false, text: "lunch at noon?", at: 1772050100000 },
  });
});

test("a deleted or empty quote is unavailable; no quote passes text through", () => {
  const base = { recipient: { id: "28:bot" }, text: "<quoted messageId=\"1\"/> hi" };
  expect(parseQuote({ ...base, entities: [{ type: "quotedReply", quotedReply: { messageId: "1", isReplyDeleted: true, preview: "x" } }] }, base.text))
    .toEqual({ text: "hi", repliedTo: expect.objectContaining({ unavailable: true }) });
  expect(parseQuote({ ...base, entities: [{ type: "quotedReply", quotedReply: { messageId: "1" } }] }, base.text).repliedTo?.unavailable).toBe(true);
  expect(parseQuote({ recipient: { id: "28:bot" } }, "plain")).toEqual({ text: "plain" });
});

test("a long quote is capped and marked truncated", () => {
  const preview = "x".repeat(5000);
  const r = parseQuote({ recipient: { id: "28:bot" }, entities: [{ type: "quotedReply", quotedReply: { messageId: "1", preview } }] }, "q");
  expect(r.repliedTo?.text).toHaveLength(2000);
  expect(r.repliedTo?.truncated).toBe(true);
});
