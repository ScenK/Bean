import OpenAI from "openai";
import type { ChatMsg, RouterDeps } from "./router.js";
import type { ConverseDeps, ToolCall } from "./converse.js";

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
        messages: Array<{ role: string; content: string }>;
        tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>;
        tool_choice?: "auto";
      }) => Promise<{
        choices: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> | null;
          };
        }>;
      }>;
    };
  };
}

export function makeOpenAIConverseWithClient(client: ToolChatClient): ConverseDeps["chat"] {
  return async ({ model, messages, tools }) => {
    const res = await client.chat.completions.create({
      model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    });
    const msg = res.choices[0]?.message;
    const content = msg?.content ?? "";
    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      try {
        toolCalls.push({ name, args: JSON.parse(tc.function?.arguments ?? "{}") });
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
