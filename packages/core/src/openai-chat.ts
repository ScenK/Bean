import OpenAI from "openai";
import type { ChatMsg, RouterDeps } from "./router.js";
import type { ConverseDeps, ConvoMsg, ToolCall } from "./converse.js";

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

interface ToolChatClient {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: Array<
          | { role: "system" | "user"; content: string }
          | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
          | { role: "tool"; content: string; tool_call_id: string }
        >;
        tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>;
        tool_choice?: "auto";
        prompt_cache_key?: string;
      }) => Promise<{
        choices: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> | null;
          };
        }>;
      }>;
    };
  };
}

function toOpenAIMessage(message: ConvoMsg): Parameters<ToolChatClient["chat"]["completions"]["create"]>[0]["messages"][number] {
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((c) => ({
              id: c.id ?? c.name,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          }
        : {}),
    };
  }
  return message;
}

export function makeOpenAIConverseWithClient(client: ToolChatClient): ConverseDeps["chat"] {
  return async ({ model, messages, tools }) => {
    const res = await client.chat.completions.create({
      model,
      messages: messages.map(toOpenAIMessage),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
      // Routing hint for OpenAI's prefix cache: all converse() calls share the same stable
      // system-prompt prefix, so pinning them to one key raises cache-hit odds under load.
      prompt_cache_key: "bean-converse",
    });
    const msg = res.choices[0]?.message;
    const content = msg?.content ?? "";
    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      try {
        toolCalls.push({ id: tc.id, name, args: JSON.parse(tc.function?.arguments ?? "{}") });
      } catch {
        /* skip malformed tool call */
      }
    }
    return { content, toolCalls };
  };
}

export function makeOpenAIConverse(apiKey: string): ConverseDeps["chat"] {
  const client = new OpenAI({ apiKey }) as unknown as ToolChatClient;
  return makeOpenAIConverseWithClient(client);
}
