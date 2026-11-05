import { expect, test } from "vitest";
import { MAX_CONTINUE_TAIL, MAX_CONTINUE_TITLE, parseDeskAck, parseDeskContinue, parseDeskResume, parseDeskSaved, parseDeskTurn } from "../src/chatops/desk.js";

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

test("parseDeskResume carries only a request and conversation id — never a session, CLI or project", () => {
  expect(parseDeskResume({ type: "desk-resume", requestId: "r1", conversationId: "c1", sessionId: "forged", cli: "codex", projectPath: "/x" }))
    .toEqual({ type: "desk-resume", requestId: "r1", conversationId: "c1" });
  for (const bad of [null, { type: "desk-resume", requestId: "r1" }, { type: "desk-turn", requestId: "r1", conversationId: "c1" }, { type: "desk-resume", requestId: "", conversationId: "c1" }]) {
    expect(parseDeskResume(bad)).toBeUndefined();
  }
});

test("parseDeskContinue keeps one mode's fields and drops mixed, oversized or malformed payloads", () => {
  const chat = { type: "desk-continue", requestId: "r1", mode: "chat", channelId: "c1", title: " Plans ", tail: "> User: hi", count: 1 };
  const agent = { type: "desk-continue", requestId: "r1", mode: "agent", channelId: "c1", title: "Fix", sessionId: "0b5c6f1e-1111-4222-8333-444455556666" };
  expect(parseDeskContinue({ ...chat, ownerId: "forged" }))
    .toEqual({ type: "desk-continue", requestId: "r1", mode: "chat", channelId: "c1", title: "Plans", tail: "> User: hi", count: 1 });
  expect(parseDeskContinue({ ...agent, cli: "codex" }))
    .toEqual({ type: "desk-continue", requestId: "r1", mode: "agent", channelId: "c1", title: "Fix", sessionId: agent.sessionId });
  for (const bad of [
    null, { ...chat, type: "desk-turn" }, { ...chat, mode: "other" }, { ...chat, mode: undefined },
    { ...chat, sessionId: agent.sessionId }, { ...agent, tail: "x" }, { ...agent, count: 1 },
    { ...chat, title: "  " }, { ...chat, title: "t".repeat(MAX_CONTINUE_TITLE + 1) },
    { ...chat, tail: "" }, { ...chat, tail: "x".repeat(MAX_CONTINUE_TAIL + 1) },
    { ...chat, count: 0 }, { ...chat, count: 1.5 }, { ...chat, count: "1" }, { ...chat, count: 201 },
    { ...chat, channelId: "" }, { ...chat, requestId: "r".repeat(201) },
    { ...agent, sessionId: "../etc" }, { ...agent, sessionId: undefined },
  ]) expect(parseDeskContinue(bad)).toBeUndefined();
});

test("parseDeskAck keeps a thread id and a partial outcome, and nothing else", () => {
  expect(parseDeskAck({ type: "desk-ack", requestId: "r1", ok: true, threadId: "t1", tail: "secret" }))
    .toEqual({ type: "desk-ack", requestId: "r1", ok: true, threadId: "t1" });
  expect(parseDeskAck({ type: "desk-ack", requestId: "r1", partial: true, threadId: "t1", error: "secret" }))
    .toEqual({ type: "desk-ack", requestId: "r1", partial: true, threadId: "t1" });
  expect(parseDeskAck({ type: "desk-ack", requestId: "r1", refused: "thread-failed", threadId: "t1" }))
    .toEqual({ type: "desk-ack", requestId: "r1", refused: "thread-failed" });
  for (const bad of [
    { type: "desk-ack", requestId: "r1", partial: true }, { type: "desk-ack", requestId: "r1", partial: "yes", threadId: "t1" },
    { type: "desk-ack", requestId: "r1", ok: true, threadId: "" }, { type: "desk-ack", requestId: "r1", ok: true, threadId: 7 },
    { type: "desk-ack", requestId: "r1", ok: true, partial: true, threadId: "t1" },
    { type: "desk-ack", requestId: "r1", partial: true, threadId: "t1", refused: "no-owner" },
  ]) expect(parseDeskAck(bad)).toBeUndefined();
});
