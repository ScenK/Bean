import OpenAI from "openai";
import type { ChatMsg, RouterDeps } from "./router.js";
import type { ConverseDeps, ConvoMsg, ToolCall } from "./converse.js";
import type { ImageGenDeps } from "./image-gen.js";

interface ChatClient {
  chat: {
    completions: {
      create: (args: { model: string; messages: ChatMsg[] }) => Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

export function makeOpenAIChatWithClient(client: ChatClient): RouterDeps["chat"] {
  return async ({ model, messages }) => {
    const res = await client.chat.completions.create({ model, messages });
    return res.choices[0]?.message?.content ?? "";
  };
}

export function makeOpenAIChat(apiKey: string): RouterDeps["chat"] {
  const client = new OpenAI({ apiKey }) as unknown as ChatClient;
  return makeOpenAIChatWithClient(client);
}

// Bean's brain talks to /v1/responses, NOT /v1/chat/completions. OpenAI rejects function
// tools combined with any reasoning effort other than "none" on chat.completions for
// gpt-5.4-nano and newer, and converse() always sends tools — so chat.completions is a dead
// end for every current reasoning model. See .memory/project-openai-responses-api.md.
type ResponsesItem =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: string | Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface ResponsesOutputItem {
  type: string;
  // A message part is either `output_text` (carrying `text`) or `refusal` (carrying `refusal`
  // and no text at all) — reading only `text` turns a refusal into an empty, silent reply.
  content?: Array<{ type?: string; text?: string; refusal?: string }> | null;
  call_id?: string;
  name?: string;
  arguments?: string;
}

// An `enum: []` — which every dynamic tool enum produces when its list is empty (no projects
// configured, no todo routines, no CLIs detected) — makes /v1/responses return status
// "incomplete" with reason "max_output_tokens", zero tokens used, and an empty output array.
// No error, just a chat that answers nothing. chat.completions tolerated it, so this only
// became fatal with the Responses port; strip those keys once here rather than at each of
// converse()'s tool definitions.
function stripEmptyEnums<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(stripEmptyEnums) as T;
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" && Array.isArray(value) && value.length === 0) continue;
    out[key] = stripEmptyEnums(value);
  }
  return out as T;
}

interface ResponsesClient {
  responses: {
    create: (args: {
      model: string;
      input: ResponsesItem[];
      tools?: Array<{ type: "function"; name: string; description: string; parameters: object; strict: boolean }>;
      tool_choice?: "auto";
      reasoning?: { effort: string };
      store?: boolean;
      prompt_cache_key?: string;
    }) => Promise<{
      output?: ResponsesOutputItem[] | null;
      status?: string | null;
      incomplete_details?: { reason?: string | null } | null;
      error?: { message?: string | null } | null;
    }>;
  };
}

// One ConvoMsg can become several input items: an assistant turn carrying N tool calls is N
// sibling function_call items, not one message with a tool_calls array (the chat.completions
// shape). Callers flatMap this.
function toResponsesItems(message: ConvoMsg): ResponsesItem[] {
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  }
  if (message.role === "assistant") {
    const calls = (message.toolCalls ?? []).map((c): ResponsesItem => ({
      type: "function_call",
      call_id: c.id ?? c.name,
      name: c.name,
      arguments: JSON.stringify(c.args ?? {}),
    }));
    // A tool-calling turn's text is usually "", and an empty assistant message is a wasted
    // (and occasionally rejected) input item — keep it only when there is something to say.
    return message.content ? [{ role: "assistant", content: message.content }, ...calls] : calls;
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return [{
      role: "user",
      content: message.content.map((p) =>
        p.type === "text"
          ? { type: "input_text" as const, text: p.text }
          : { type: "input_image" as const, image_url: `data:${p.image.mimeType};base64,${p.image.data}` }),
    }];
  }
  return [message as { role: "system"; content: string } | { role: "user"; content: string }];
}

export function makeOpenAIConverseWithClient(client: ResponsesClient, reasoningEffort = ""): ConverseDeps["chat"] {
  return async ({ model, messages, tools }) => {
    const res = await client.responses.create({
      model,
      input: messages.flatMap(toResponsesItems),
      // strict must be sent explicitly: Responses treats an omitted `strict` as true, and a
      // strict schema makes EVERY property required. That silently broke the optional
      // arguments converse() relies on — propose_run's no-project scratch run became
      // unreachable, and propose_delegate's optional skill/cli/model were forced.
      tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: stripEmptyEnums(t.parameters), strict: false })),
      tool_choice: "auto",
      // Omitted unless the user picked one in Settings: sending reasoning.effort to a model
      // that has no reasoning (gpt-4o-mini, gpt-5.4-nano) is a hard 400, so "" must mean
      // "send nothing" rather than any default value.
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      // Responses defaults to store:true, which would persist every Bean conversation in the
      // user's OpenAI account — chat.completions never did. Not a setting; keep it off.
      store: false,
      // Routing hint for OpenAI's prefix cache: converse() calls (and routine chat steps,
      // which share this adapter) reuse stable prompt prefixes, so pinning them to one key
      // raises cache-hit odds under load. Bean's volume stays far below the per-key rate
      // where a shared key would hurt routing.
      prompt_cache_key: "bean-converse",
    });
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const item of res.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) content += part.text ?? part.refusal ?? "";
        continue;
      }
      // Reasoning items also arrive here and are dropped: the tool round trip is accepted
      // without echoing them back, so Bean's 3-round loop carries no reasoning state.
      if (item.type !== "function_call" || !item.name) continue;
      try {
        toolCalls.push({ id: item.call_id, name: item.name, args: JSON.parse(item.arguments ?? "{}") });
      } catch {
        /* skip malformed tool call */
      }
    }
    // Anything short of a completed response must not pass silently. A failed or cancelled
    // response has no trustworthy output at all; a truncated one must never trigger a tool
    // call, and its partial text is labelled rather than presented as a finished answer.
    // converse() turns each throw into a visible reply naming the reason.
    if (res.status === "failed" || res.status === "cancelled") {
      throw new Error(`response ${res.status}${res.error?.message ? `: ${res.error.message}` : ""}`);
    }
    if (res.status === "incomplete" && (!content || toolCalls.length > 0)) {
      throw new Error(`response incomplete (${res.incomplete_details?.reason ?? "unknown reason"})`);
    }
    if (res.status === "incomplete") return { content: `${content}\n\n_(cut off — the model hit its output limit.)_`, toolCalls };
    return { content, toolCalls };
  };
}

export function makeOpenAIConverse(apiKey: string, reasoningEffort = ""): ConverseDeps["chat"] {
  const client = new OpenAI({ apiKey }) as unknown as ResponsesClient;
  return makeOpenAIConverseWithClient(client, reasoningEffort);
}

interface ImageClient {
  images: { generate: (a: { model: string; prompt: string; response_format?: "b64_json" }) => Promise<{ data?: Array<{ b64_json?: string }> }> };
}

export function makeOpenAIImageGenWithClient(client: ImageClient): ImageGenDeps["generate"] {
  return async ({ model, prompt }) => {
    // gpt-image-* always returns b64 and rejects response_format; dall-e-* defaults to a URL,
    // so it must be asked for b64 explicitly or generation "succeeds" with no data for us.
    const res = await client.images.generate({
      model, prompt,
      ...(model.startsWith("dall-e") ? { response_format: "b64_json" as const } : {}),
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Images API returned no image data");
    return { b64 };
  };
}

export function makeOpenAIImageGen(apiKey: string): ImageGenDeps["generate"] {
  return makeOpenAIImageGenWithClient(new OpenAI({ apiKey }) as unknown as ImageClient);
}
