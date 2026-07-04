import { expect, test } from "vitest";
import { extractMemories } from "../src/memory/extract.js";
import type { ConverseDeps, ToolSpec } from "../src/converse.js";
import type { Memory } from "../src/memory/memory.js";
import type { Project } from "../src/types.js";

const projects: Project[] = [
  { name: "api", path: "/work/api" },
  { name: "bean", path: "/dev/bean" },
];
const transcript = [
  { role: "user" as const, content: "I always use pnpm, never npm" },
  { role: "assistant" as const, content: "Noted." },
];

function depsReturning(toolCalls: { name: string; args: unknown }[]): ConverseDeps {
  return { model: "m", chat: async () => ({ content: "", toolCalls }) };
}

test("empty transcript short-circuits to no candidates and never calls chat", async () => {
  let called = false;
  const deps: ConverseDeps = { model: "m", chat: async () => { called = true; return { content: "", toolCalls: [] }; } };
  expect(await extractMemories([], [], projects, deps)).toEqual([]);
  expect(called).toBe(false);
});

test("remember tool calls become candidates; a valid projectPath is kept", async () => {
  const deps = depsReturning([
    { name: "remember", args: { text: "prefers pnpm" } },
    { name: "remember", args: { text: "auth lives in core", projectPath: "/work/api" } },
  ]);
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([
    { text: "prefers pnpm", projectPath: undefined },
    { text: "auth lives in core", projectPath: "/work/api" },
  ]);
});

test("an unknown projectPath is dropped to a global candidate", async () => {
  const deps = depsReturning([{ name: "remember", args: { text: "x", projectPath: "/nowhere" } }]);
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([{ text: "x", projectPath: undefined }]);
});

test("blank/missing text and non-remember calls are skipped", async () => {
  const deps = depsReturning([
    { name: "remember", args: { text: "   " } },
    { name: "other", args: { text: "ignore" } },
    { name: "remember", args: {} },
  ]);
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([]);
});

test("candidates duplicating existing memory (case-insensitive) are dropped", async () => {
  const existing: Memory[] = [{ id: "1", text: "Prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const deps = depsReturning([
    { name: "remember", args: { text: "prefers pnpm" } },
    { name: "remember", args: { text: "new fact" } },
  ]);
  expect(await extractMemories(transcript, existing, projects, deps)).toEqual([{ text: "new fact", projectPath: undefined }]);
});

test("a chat failure yields no candidates (never throws)", async () => {
  const deps: ConverseDeps = { model: "m", chat: async () => { throw new Error("network"); } };
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([]);
});

test("the remember tool constrains projectPath to known project paths", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = { model: "m", chat: async ({ tools }) => { captured = tools; return { content: "", toolCalls: [] }; } };
  await extractMemories(transcript, [], projects, deps);
  const props = (captured[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.projectPath?.enum).toEqual(["/work/api", "/dev/bean"]);
});
