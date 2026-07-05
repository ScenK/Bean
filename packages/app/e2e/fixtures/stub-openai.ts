import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubReply {
  content?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

export interface StubOpenAI {
  url: string;
  /** Queues one canned response; each `/v1/chat/completions` request consumes the next queued
   * reply, FIFO. Queue exactly as many replies as requests the test will trigger — an
   * under-queued request gets a safe empty-content fallback rather than hanging. */
  queue: (reply: StubReply) => void;
  close: () => Promise<void>;
}

/**
 * A minimal stand-in for `POST /v1/chat/completions` — just enough of the OpenAI response
 * shape that `makeOpenAIConverseWithClient` (packages/core/src/openai-chat.ts) reads:
 * `choices[0].message.content` and, for tool calls, `choices[0].message.tool_calls[].function`.
 */
export async function startStubOpenAI(): Promise<StubOpenAI> {
  const replies: StubReply[] = [];
  const server: Server = createServer((req, res) => {
    req.resume(); // drain the request body so 'end' fires; we don't need its contents
    req.on("end", () => {
      const reply = replies.shift();
      const message: Record<string, unknown> = { content: reply?.content ?? "" };
      if (reply?.toolCall) {
        message.tool_calls = [
          { function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } },
        ];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    queue: (reply) => replies.push(reply),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
