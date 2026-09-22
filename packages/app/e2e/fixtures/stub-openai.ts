import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubReply {
  content?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

export interface StubOpenAI {
  url: string;
  /** Queues one canned response; each `/v1/responses` request consumes the next queued
   * reply, FIFO. Queue exactly as many replies as requests the test will trigger — an
   * under-queued request gets a safe empty-content fallback rather than hanging. */
  queue: (reply: StubReply) => void;
  close: () => Promise<void>;
}

/**
 * A minimal stand-in for `POST /v1/responses` — just enough of the OpenAI response shape that
 * `makeOpenAIConverseWithClient` (packages/core/src/openai-chat.ts) reads: the `output[]`
 * array, with `message` items carrying `content[].text` and `function_call` items carrying
 * `name`/`arguments`/`call_id`. Bean's brain left chat.completions because function tools and
 * reasoning effort can't be combined there — see .memory/project-openai-responses-api.md.
 */
export async function startStubOpenAI(): Promise<StubOpenAI> {
  const replies: StubReply[] = [];
  const server: Server = createServer((req, res) => {
    req.resume(); // drain the request body so 'end' fires; we don't need its contents
    req.on("end", () => {
      const reply = replies.shift();
      const output: Record<string, unknown>[] = [
        { type: "message", content: [{ type: "output_text", text: reply?.content ?? "" }] },
      ];
      if (reply?.toolCall) {
        output.push({
          type: "function_call",
          call_id: `call_${reply.toolCall.name}`,
          name: reply.toolCall.name,
          arguments: JSON.stringify(reply.toolCall.args),
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output }));
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
