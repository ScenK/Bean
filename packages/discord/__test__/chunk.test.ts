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

  test("a failing record doesn't fail the send", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const record = () => { throw new Error("db locked"); };
    await expect(sendChunks(long, sender().send, { record })).resolves.toHaveLength(3);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
