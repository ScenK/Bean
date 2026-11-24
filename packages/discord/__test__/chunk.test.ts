import { describe, expect, test, vi } from "vitest";
import { chunkText, sendChunks } from "../src/chunk.js";

test("short text passes through as one chunk", () => {
  expect(chunkText("hello")).toEqual(["hello"]);
});

test("empty text yields no chunks", () => {
  expect(chunkText("")).toEqual([]);
});

test("splits on line boundaries under the limit", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(50)}`);
  const chunks = chunkText(lines.join("\n"), 120);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
  expect(chunks.join("\n")).toBe(lines.join("\n")); // nothing lost
});

test("hard-splits a single over-long line", () => {
  const long = "a".repeat(4500);
  const chunks = chunkText(long, 2000);
  expect(chunks).toEqual(["a".repeat(2000), "a".repeat(2000), "a".repeat(500)]);
});

describe("fence-aware chunkText", () => {
  const body = Array.from({ length: 30 }, (_, i) => `const v${i} = ${"x".repeat(20)};`);
  const text = ["intro", "```ts", ...body, "```", "outro"].join("\n");
  const chunks = chunkText(text, 200);
  const fenceLines = (c: string) => c.split("\n").filter((l) => l.startsWith("```")).length;

  test("a split fence closes in one chunk and reopens with its info string in the next", () => {
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      expect(fenceLines(c) % 2).toBe(0);
    }
    for (const c of chunks.slice(1, -1)) {
      expect(c.startsWith("```ts\n")).toBe(true);
      expect(c.endsWith("\n```")).toBe(true);
    }
  });

  test("joined minus the added fences equals the input", () => {
    expect(chunks.join("\n").replaceAll("\n```\n```ts", "")).toBe(text);
  });

  test("a chunk never ends on a bare opening line", () => {
    const t = `${"a".repeat(95)}\n\`\`\`\n${"b".repeat(90)}\n\`\`\``;
    expect(chunkText(t, 100)).toEqual(["a".repeat(95), `\`\`\`\n${"b".repeat(90)}\n\`\`\``]);
  });

  test("a hard-split line inside a fence keeps every piece fenced and under the limit", () => {
    const t = `\`\`\`\n${"z".repeat(250)}\n\`\`\``;
    const out = chunkText(t, 100);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(fenceLines(c) % 2).toBe(0);
    }
    expect(out.join("").replaceAll(/\n?```\n?/g, "")).toBe("z".repeat(250));
    expect(out.at(-1)).not.toBe("```\n```"); // the real closer isn't left as an empty block
  });
});

describe("sendChunks", () => {
  const long = `${"a".repeat(2000)}\n${"b".repeat(2000)}\nc`;
  const sender = (failAt = -1) => {
    const sent: string[] = [];
    const send = async (chunk: string) => {
      if (sent.length === failAt) throw new Error("send failed");
      sent.push(chunk);
      return { id: `m${sent.length}` };
    };
    return { sent, send };
  };

  test("a single-chunk send records nothing", async () => {
    const record = vi.fn();
    const { sent, send } = sender();
    await sendChunks("hello", send, { record });
    expect(sent).toEqual(["hello"]);
    expect(record).not.toHaveBeenCalled();
  });

  test("a full multi-chunk send records one group in order; chunks are chunkText's", async () => {
    const record = vi.fn();
    const { sent, send } = sender();
    await sendChunks(long, send, { record });
    expect(sent).toEqual(chunkText(long));
    expect(record.mock.calls).toEqual([[["m1", "m2", "m3"]]]);
  });

  test("a send that throws on chunk 2 records nothing", async () => {
    const record = vi.fn();
    await expect(sendChunks(long, sender(1).send, { record })).rejects.toThrow("send failed");
    expect(record).not.toHaveBeenCalled();
  });

  test("tables are rendered before chunking", async () => {
    const { sent, send } = sender();
    await sendChunks("| a | b |\n|-|-|\n| x | y |", send, { record: vi.fn() });
    expect(sent).toEqual(["```\na  b\n-  -\nx  y\n```"]);
  });

  test("a failing record doesn't fail the send", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const record = () => { throw new Error("db locked"); };
    await expect(sendChunks(long, sender().send, { record })).resolves.toHaveLength(3);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
