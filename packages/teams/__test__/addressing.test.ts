import { expect, test } from "vitest";
import { addressedToBot, type AddressActivity } from "../src/addressing.js";

const BOT = "28:app-id";
const channel = (recipient: AddressActivity["recipient"], entities?: AddressActivity["entities"]): AddressActivity =>
  ({ conversation: { conversationType: "channel" }, recipient, entities });

test("a personal chat is always addressed", () => {
  expect(addressedToBot({ conversation: { conversationType: "personal" }, recipient: { id: BOT } }, BOT)).toBe(true);
});

test("an @mention of the bot is addressed; a mention of someone else is not", () => {
  expect(addressedToBot(channel({ id: BOT }, [{ type: "mention", mentioned: { id: BOT } }]), BOT)).toBe(true);
  expect(addressedToBot(channel({ id: BOT }, [{ type: "mention", mentioned: { id: "29:alex" } }]), BOT)).toBe(false);
});

test("a targeted message with no mention is addressed", () => {
  expect(addressedToBot(channel({ id: BOT, isTargeted: true }), BOT)).toBe(true);
});

test("isTargeted false, missing, or a non-boolean is not addressed", () => {
  expect(addressedToBot(channel({ id: BOT, isTargeted: false }), BOT)).toBe(false);
  expect(addressedToBot(channel({ id: BOT }), BOT)).toBe(false);
  expect(addressedToBot(channel({ id: BOT, isTargeted: "true" }), BOT)).toBe(false);
});

test("a targeted message whose recipient is not the bot is not addressed", () => {
  expect(addressedToBot(channel({ id: "28:other-app", isTargeted: true }), BOT)).toBe(false);
});
