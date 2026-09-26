import { expect, test } from "vitest";
import { makeOpenAIChatWithClient, makeOpenAIConverseWithClient, makeOpenAISpeakWithClient, makeOpenAITranscribeWithClient } from "../src/openai-chat.js";

// A fake /v1/responses client that records the request and replays a canned output[].
function fakeResponses(output: unknown[] = [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]) {
  const seen: { args?: Record<string, unknown> } = {};
  const client = { responses: { create: async (args: Record<string, unknown>) => { seen.args = args; return { output }; } } };
  return { client, seen };
}

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
  const { client } = fakeResponses([
    { type: "reasoning", content: [], encrypted_content: "gAAA" },
    { type: "message", content: [{ type: "output_text", text: "sure" }] },
    {
      type: "function_call",
      call_id: "call_run",
      name: "propose_run",
      arguments: '{"skill":"review-code","project":"/work/api","instruction":"go"}',
    },
  ]);
  const chat = makeOpenAIConverseWithClient(client as never);
  const out = await chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  expect(out.content).toBe("sure");
  expect(out.toolCalls).toHaveLength(1);
  expect(out.toolCalls[0]?.id).toBe("call_run");
  expect(out.toolCalls[0]?.name).toBe("propose_run");
  expect((out.toolCalls[0]?.args as { skill?: string }).skill).toBe("review-code");
});

test("converse adapter sends assistant tool calls and tool results as sibling items", async () => {
  const { client, seen } = fakeResponses();
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({
    model: "m",
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "set_reminder", args: { text: "stretch" } }] },
      { role: "tool", content: "reminder saved", toolCallId: "call_1" },
    ],
    tools: [],
  });

  expect(seen.args?.input).toEqual([
    { type: "function_call", call_id: "call_1", name: "set_reminder", arguments: '{"text":"stretch"}' },
    { type: "function_call_output", call_id: "call_1", output: "reminder saved" },
  ]);
  expect(seen.args?.prompt_cache_key).toBe("bean-converse");
  // Responses defaults to persisting conversations in the user's OpenAI account.
  expect(seen.args?.store).toBe(false);
});

test("converse adapter keeps assistant text alongside its tool calls", async () => {
  const { client, seen } = fakeResponses();
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({
    model: "m",
    messages: [{ role: "assistant", content: "on it", toolCalls: [{ name: "set_reminder", args: {} }] }],
    tools: [],
  });
  expect(seen.args?.input).toEqual([
    { role: "assistant", content: "on it" },
    // No id on the ToolCall — the name is the fallback call_id, as before.
    { type: "function_call", call_id: "set_reminder", name: "set_reminder", arguments: "{}" },
  ]);
});

test("converse adapter sends tools flat, not nested under function", async () => {
  const { client, seen } = fakeResponses();
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({
    model: "m",
    messages: [],
    tools: [{ name: "set_reminder", description: "set one", parameters: { type: "object" } }],
  });
  // strict:false is load-bearing — Responses treats an omitted strict as true, which makes
  // every property required and breaks converse()'s optional arguments.
  expect(seen.args?.tools).toEqual([
    { type: "function", name: "set_reminder", description: "set one", parameters: { type: "object" }, strict: false },
  ]);
  expect(seen.args?.tool_choice).toBe("auto");
});

test("converse adapter omits reasoning unless an effort is configured", async () => {
  const off = fakeResponses();
  await makeOpenAIConverseWithClient(off.client as never)({ model: "m", messages: [], tools: [] });
  expect(off.seen.args).not.toHaveProperty("reasoning");

  const on = fakeResponses();
  await makeOpenAIConverseWithClient(on.client as never, "high")({ model: "m", messages: [], tools: [] });
  expect(on.seen.args?.reasoning).toEqual({ effort: "high" });
});

test("converse adapter maps user image parts to input_image data URLs", async () => {
  const { client, seen } = fakeResponses();
  const chat = makeOpenAIConverseWithClient(client as never);
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
  expect((seen.args?.input as Array<{ content: unknown }>)[0]?.content).toEqual([
    { type: "input_text", text: "what is this?" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
});

test("converse adapter passes plain-string user content through unchanged", async () => {
  const { client, seen } = fakeResponses();
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  expect(seen.args?.input).toEqual([{ role: "user", content: "hi" }]);
});

test("converse adapter skips a tool call with malformed arguments", async () => {
  const { client } = fakeResponses([
    { type: "function_call", call_id: "c1", name: "propose_run", arguments: "{not json" },
  ]);
  const chat = makeOpenAIConverseWithClient(client as never);
  const out = await chat({ model: "m", messages: [], tools: [] });
  expect(out.content).toBe("");
  expect(out.toolCalls).toHaveLength(0);
});

test("converse adapter strips empty tool enums, which /v1/responses answers with silence", async () => {
  const { client, seen } = fakeResponses();
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({
    model: "m",
    messages: [],
    tools: [{
      name: "propose_run",
      description: "propose a run",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", enum: ["review-pr"] },
          project: { type: "string", enum: [] },
          nested: { type: "object", properties: { cli: { type: "string", enum: [] } } },
        },
      },
    }],
  });
  const params = (seen.args?.tools as Array<{ parameters: Record<string, never> }>)[0]!.parameters;
  expect(params).toEqual({
    type: "object",
    properties: {
      skill: { type: "string", enum: ["review-pr"] },
      project: { type: "string" },
      nested: { type: "object", properties: { cli: { type: "string" } } },
    },
  });
});

test("converse adapter throws when a truncated response carries no content or tool call", async () => {
  const client = {
    responses: { create: async () => ({ output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) },
  };
  const chat = makeOpenAIConverseWithClient(client as never);
  await expect(chat({ model: "m", messages: [], tools: [] })).rejects.toThrow("max_output_tokens");
});

test("converse adapter labels truncated text instead of passing it off as a finished answer", async () => {
  const client = {
    responses: { create: async () => ({ output: [{ type: "message", content: [{ text: "partial" }] }], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) },
  };
  const out = await makeOpenAIConverseWithClient(client as never)({ model: "m", messages: [], tools: [] });
  expect(out.content).toContain("partial");
  expect(out.content).toContain("cut off");
});

test("converse adapter refuses to act on a tool call from a truncated response", async () => {
  const client = {
    responses: { create: async () => ({
      output: [{ type: "function_call", call_id: "c1", name: "set_reminder", arguments: "{}" }],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }) },
  };
  await expect(makeOpenAIConverseWithClient(client as never)({ model: "m", messages: [], tools: [] }))
    .rejects.toThrow("max_output_tokens");
});

test("converse adapter throws on a failed response, naming the error", async () => {
  const client = {
    responses: { create: async () => ({ output: [], status: "failed", error: { message: "server had a problem" } }) },
  };
  await expect(makeOpenAIConverseWithClient(client as never)({ model: "m", messages: [], tools: [] }))
    .rejects.toThrow("server had a problem");
});

test("converse adapter surfaces a refusal, which carries no text part", async () => {
  const client = {
    responses: { create: async () => ({ output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }], status: "completed" }) },
  };
  const out = await makeOpenAIConverseWithClient(client as never)({ model: "m", messages: [], tools: [] });
  expect(out.content).toBe("I can't help with that.");
});

test("makeOpenAITranscribeWithClient sends the audio as a named file and returns the trimmed transcript", async () => {
  let sent: { model: string; file: File } | undefined;
  const t = makeOpenAITranscribeWithClient({
    audio: { transcriptions: { create: async (a) => { sent = a; return { text: "  hello bean \n" }; } } },
  });
  expect(await t(new TextEncoder().encode("ogg").buffer, "voice-message.ogg", "audio/ogg")).toBe("hello bean");
  expect(sent?.model).toBe("gpt-4o-mini-transcribe");
  expect(sent?.file.name).toBe("voice-message.ogg");
  expect(sent?.file.type).toBe("audio/ogg");
});

test("makeOpenAISpeakWithClient returns mp3 bytes and caps input at the API's 4096 chars", async () => {
  let sent: { model: string; voice: string; input: string; instructions: string; response_format: "mp3" } | undefined;
  const speak = makeOpenAISpeakWithClient({
    audio: { speech: { create: async (a) => { sent = a; return { arrayBuffer: async () => new TextEncoder().encode("mp3").buffer }; } } },
  });
  expect((await speak("x".repeat(5000))).toString()).toBe("mp3");
  expect(sent?.model).toBe("gpt-4o-mini-tts");
  expect(sent?.voice).toBe("marin");
  expect(sent?.instructions).toMatch(/warm/);
  expect(sent?.response_format).toBe("mp3");
  expect(sent?.input).toHaveLength(4096);
});
