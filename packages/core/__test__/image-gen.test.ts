import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGenerateImageTool } from "../src/image-gen.js";
import { makeOpenAIImageGenWithClient } from "../src/openai-chat.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-img-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("makeGenerateImageTool", () => {
  it("writes the PNG, collects the path, fires onStart, returns the path in the result", async () => {
    const onStart = vi.fn();
    const { tool, paths } = makeGenerateImageTool({
      generate: async ({ model, prompt }) => {
        expect(model).toBe("gpt-image-2");
        expect(prompt).toBe("a red cat");
        return { b64: Buffer.from("png-bytes").toString("base64") };
      },
      model: "gpt-image-2",
      imagesDir: dir,
      onStart,
    });
    const result = await tool.run({ prompt: "a red cat" });
    expect(onStart).toHaveBeenCalledOnce();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/a-red-cat\.png$/);
    expect((await readFile(paths[0]!)).toString()).toBe("png-bytes");
    expect(result).toContain(paths[0]!);
  });

  it("returns an error string instead of throwing when the API fails", async () => {
    const { tool, paths } = makeGenerateImageTool({
      generate: async () => { throw new Error("quota exceeded"); },
      model: "gpt-image-2",
      imagesDir: dir,
    });
    const result = await tool.run({ prompt: "x" });
    expect(result).toContain("quota exceeded");
    expect(paths).toHaveLength(0);
  });

  it("rejects a missing prompt without calling the API", async () => {
    const generate = vi.fn();
    const { tool } = makeGenerateImageTool({ generate, model: "m", imagesDir: dir });
    const result = await tool.run({});
    expect(result).toMatch(/prompt/i);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("makeOpenAIImageGenWithClient", () => {
  it("returns the first b64_json payload", async () => {
    const generate = makeOpenAIImageGenWithClient({
      images: { generate: async () => ({ data: [{ b64_json: "QUJD" }] }) },
    });
    expect(await generate({ model: "m", prompt: "p" })).toEqual({ b64: "QUJD" });
  });

  it("requests b64_json only for dall-e models (gpt-image rejects the param)", async () => {
    const formats: Array<string | undefined> = [];
    const generate = makeOpenAIImageGenWithClient({
      images: {
        generate: async (a) => { formats.push(a.response_format); return { data: [{ b64_json: "QUJD" }] }; },
      },
    });
    await generate({ model: "dall-e-3", prompt: "p" });
    await generate({ model: "gpt-image-2", prompt: "p" });
    expect(formats).toEqual(["b64_json", undefined]);
  });

  it("throws when the API returns no image data", async () => {
    const generate = makeOpenAIImageGenWithClient({ images: { generate: async () => ({}) } });
    await expect(generate({ model: "m", prompt: "p" })).rejects.toThrow(/no image data/);
  });
});
