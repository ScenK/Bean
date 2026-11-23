import { expect, test } from "vitest";
import { proposeMemoryConsolidation } from "../src/memory/consolidate.js";
import type { Memory } from "../src/memory/memory.js";
import type { ToolCall } from "../src/converse.js";

const m = (id: string, text: string): Memory => ({ id, text, createdAt: "2026-01-01T00:00:00.000Z" });

test("empty memory list needs no model call and returns nothing", async () => {
  const result = await proposeMemoryConsolidation([], { chat: async () => ({ content: "", toolCalls: [] }), model: "m" });
  expect(result).toEqual({ merges: [], drops: [] });
});

test("parses merge_memories and drop_memory tool calls, dropping unknown ids", async () => {
  const memories = [m("a", "likes pnpm"), m("b", "prefers pnpm over npm"), m("c", "stale fact")];
  const toolCalls: ToolCall[] = [
    { name: "merge_memories", args: { ids: ["a", "b"], mergedText: "prefers pnpm" } },
    { name: "drop_memory", args: { id: "c" } },
    { name: "drop_memory", args: { id: "unknown-id" } },
  ];
  const result = await proposeMemoryConsolidation(memories, {
    chat: async () => ({ content: "", toolCalls }),
    model: "m",
  });
  expect(result.merges).toEqual([{ ids: ["a", "b"], mergedText: "prefers pnpm" }]);
  expect(result.drops).toEqual(["c"]);
});

test("a merged id is not also reported as a standalone drop", async () => {
  const memories = [m("a", "one"), m("b", "two")];
  const toolCalls: ToolCall[] = [
    { name: "merge_memories", args: { ids: ["a", "b"], mergedText: "one and two" } },
    { name: "drop_memory", args: { id: "a" } },
  ];
  const result = await proposeMemoryConsolidation(memories, {
    chat: async () => ({ content: "", toolCalls }),
    model: "m",
  });
  expect(result.drops).toEqual([]);
});

test("a chat failure returns an empty result flagged failed instead of throwing", async () => {
  const result = await proposeMemoryConsolidation([m("a", "x")], {
    chat: async () => { throw new Error("down"); },
    model: "m",
  });
  expect(result).toEqual({ merges: [], drops: [], failed: true });
});

test("a single-id merge is a rewrite (e.g. relative → absolute date), and facts carry their saved date", async () => {
  const memories = [m("a", "trip is next week")];
  let prompt = "";
  const toolCalls: ToolCall[] = [{ name: "merge_memories", args: { ids: ["a"], mergedText: "trip is the week of 2026-01-08" } }];
  const result = await proposeMemoryConsolidation(memories, {
    chat: async ({ messages }) => { prompt = String(messages[1]!.content); return { content: "", toolCalls }; },
    model: "m",
  });
  expect(prompt).toContain("[a] (saved 2026-01-01) trip is next week");
  expect(result.merges).toEqual([{ ids: ["a"], mergedText: "trip is the week of 2026-01-08" }]);
});

test("a decision whose text states an earlier date keeps it through a dream rewrite", async () => {
  const decision: Memory = { id: "a", text: "On 2026-10-02 Scen chose a 24-hour veto for triage", createdAt: "2026-11-20T00:00:00.000Z", kind: "decision" };
  let system = "";
  let user = "";
  const toolCalls: ToolCall[] = [{ name: "merge_memories", args: { ids: ["a"], mergedText: "On 2026-10-02 Scen chose a 24-hour veto for Bean triage" } }];
  const result = await proposeMemoryConsolidation([decision], {
    chat: async ({ messages }) => { system = String(messages[0]!.content); user = String(messages[1]!.content); return { content: "", toolCalls }; },
    model: "m",
  });
  expect(user).toContain("[a] (saved 2026-11-20) {decision} On 2026-10-02 Scen chose");
  expect(system).toContain("Keep an explicit date the text states (when something was decided or happened) through every merge and rewrite");
  expect(system).toContain("only when the text is about the day it was saved");
  expect(system).toContain("settled as of its saved date — the date it was recorded, not when it was decided");
  expect(system).not.toContain("settled on its saved date");
  expect(result.merges[0]!.mergedText).toContain("2026-10-02");
});
