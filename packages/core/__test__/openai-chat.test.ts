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
              tool_calls: [{ id: "call_run", function: { name: "propose_run", arguments: '{"skill":"review-code","project":"/work/api","instruction":"go"}' } }],
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
  expect(out.toolCalls[0]?.id).toBe("call_run");
  expect(out.toolCalls[0]?.name).toBe("propose_run");
  expect((out.toolCalls[0]?.args as { skill?: string }).skill).toBe("review-code");
});

test("converse adapter sends assistant tool calls and tool result messages", async () => {
  let createdArgs: unknown;
  const fakeClient = {
    chat: {
      completions: {
        create: async (args: unknown) => {
          createdArgs = args;
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  await chat({
    model: "m",
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "set_reminder", args: { text: "stretch" } }] },
      { role: "tool", content: "reminder saved", toolCallId: "call_1" },
    ],
    tools: [],
  });

  expect((createdArgs as { messages: unknown[] }).messages).toEqual([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "set_reminder", arguments: '{"text":"stretch"}' } }],
    },
    { role: "tool", content: "reminder saved", tool_call_id: "call_1" },
  ]);
  expect((createdArgs as { prompt_cache_key?: string }).prompt_cache_key).toBe("bean-converse");
});

test("converse adapter maps user image parts to image_url data URLs", async () => {
  let createdArgs: unknown;
  const fakeClient = {
    chat: {
      completions: {
        create: async (args: unknown) => {
          createdArgs = args;
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  await chat({
    model: "m",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", image: { data: "AAAA", mimeType: "image/png" } },
      ],
    }],
    tools: [],
  });
  expect((createdArgs as { messages: Array<{ content: unknown }> }).messages[0]?.content).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
});

test("converse adapter passes plain-string user content through unchanged", async () => {
  let createdArgs: unknown;
  const fakeClient = {
    chat: {
      completions: {
        create: async (args: unknown) => {
          createdArgs = args;
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  await chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  expect((createdArgs as { messages: Array<{ content: unknown }> }).messages[0]?.content).toBe("hi");
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
