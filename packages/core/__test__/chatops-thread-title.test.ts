import { expect, test } from "vitest";
import { threadTitle } from "../src/chatops/thread-title.js";

const reply = (content: string) => ({ chat: async () => ({ content, toolCalls: [] }), model: "m" });

test("uses the model's title, stripped of quotes", async () => {
  expect(await threadTitle("who owns the jira backlog?", reply('"Jira backlog owners"'))).toBe("Jira backlog owners");
});

test("falls back to the clipped first line when the model fails", async () => {
  const deps = { chat: async () => { throw new Error("down"); }, model: "m" };
  expect(await threadTitle("\n  first line \nsecond", deps)).toBe("first line");
  const long = await threadTitle("x".repeat(300), deps);
  expect(long).toHaveLength(100);
  expect(long.endsWith("…")).toBe(true);
});

test("never returns an empty name", async () => {
  expect(await threadTitle("", reply(""))).toBe("Bean session");
});
