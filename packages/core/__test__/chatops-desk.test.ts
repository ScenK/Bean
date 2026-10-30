import { expect, test } from "vitest";
import { parseDeskAck, parseDeskSaved, parseDeskTurn } from "../src/chatops/desk.js";

test("parseDeskTurn keeps only the three fields of a well-formed turn", () => {
  expect(parseDeskTurn({ type: "desk-turn", requestId: "r1", conversationId: "c1", text: "hi", fromId: "x" }))
    .toEqual({ type: "desk-turn", requestId: "r1", conversationId: "c1", text: "hi" });
});

test("parseDeskTurn rejects malformed, oversized and unknown messages", () => {
  const ok = { type: "desk-turn", requestId: "r1", conversationId: "c1", text: "hi" };
  for (const bad of [
    null, "desk-turn", 42, {}, { ...ok, type: "turn" }, { ...ok, requestId: "" }, { ...ok, requestId: 1 },
    { ...ok, conversationId: undefined }, { ...ok, text: "   " }, { ...ok, text: ["hi"] },
    { ...ok, requestId: "r".repeat(201) }, { ...ok, conversationId: "c".repeat(201) }, { ...ok, text: "x".repeat(64_001) },
  ]) expect(parseDeskTurn(bad)).toBeUndefined();
});

test("parseDeskAck accepts ok or a known refusal code, and never carries text", () => {
  expect(parseDeskAck({ type: "desk-ack", requestId: "r1", ok: true, text: "secret" })).toEqual({ type: "desk-ack", requestId: "r1", ok: true });
  expect(parseDeskAck({ type: "desk-ack", requestId: "r1", refused: "queue-full", detail: "secret" }))
    .toEqual({ type: "desk-ack", requestId: "r1", refused: "queue-full" });
  for (const bad of [
    undefined, { type: "desk-ack", requestId: "r1" }, { type: "desk-ack", requestId: "r1", ok: false },
    { type: "desk-ack", requestId: "r1", refused: "nope" }, { type: "desk-ack", requestId: "r1", ok: true, refused: "too-long" },
    { type: "desk-ack", requestId: "", ok: true }, { type: "saved", requestId: "r1", ok: true },
    { type: "desk-ack", requestId: "r1", refused: "hasOwnProperty" },
  ]) expect(parseDeskAck(bad)).toBeUndefined();
});

test("parseDeskSaved accepts a conversation id only", () => {
  expect(parseDeskSaved({ type: "saved", conversationId: "c1", text: "x" })).toEqual({ type: "saved", conversationId: "c1" });
  for (const bad of [null, { type: "saved" }, { type: "saved", conversationId: "" }, { type: "saved", conversationId: "c".repeat(201) }, { type: "desk-ack", conversationId: "c1" }]) {
    expect(parseDeskSaved(bad)).toBeUndefined();
  }
});
