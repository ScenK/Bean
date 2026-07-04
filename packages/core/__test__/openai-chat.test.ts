import { expect, test } from "vitest";
import { makeOpenAIChatWithClient, makeOpenAIConverseWithClient } from "../src/openai-chat.js";

test("returns first choice content", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: "hello" } }] }),
      },
    },
  };
  const chat = makeOpenAIChatWithClient(fakeClient as never);
  const out = await chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  expect(out).toBe("hello");
});

test("returns empty string when no choices", async () => {
  const fakeClient = {
    chat: { completions: { create: async () => ({ choices: [] }) } },
  };
  const chat = makeOpenAIChatWithClient(fakeClient as never);
  expect(await chat({ model: "m", messages: [] })).toBe("");
});

test("converse adapter maps content and a tool call", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: "sure",
              tool_calls: [{ function: { name: "propose_run", arguments: '{"skill":"review-code","project":"/work/api","instruction":"go"}' } }],
            },
          }],
        }),
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  const out = await chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  expect(out.content).toBe("sure");
  expect(out.toolCalls).toHaveLength(1);
  expect(out.toolCalls[0]?.name).toBe("propose_run");
  expect((out.toolCalls[0]?.args as { skill?: string }).skill).toBe("review-code");
});

test("converse adapter skips a tool call with malformed arguments", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: { content: "", tool_calls: [{ function: { name: "propose_run", arguments: "{not json" } }] },
          }],
        }),
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  const out = await chat({ model: "m", messages: [], tools: [] });
  expect(out.content).toBe("");
  expect(out.toolCalls).toHaveLength(0);
});
