import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionTool } from "./converse.js";

export interface ImageGenDeps {
  generate: (args: { model: string; prompt: string }) => Promise<{ b64: string }>;
  model: string;
  imagesDir: string;
  /** Fired when a generation actually starts — surfaces show a "🎨 working" indicator
   * (generation routinely takes tens of seconds). */
  onStart?: () => void;
  /** Also stores the image in bean.db's note_images so the model can embed it in a note as
   * `bean-image:<id>` (note-images.ts). Omit and the tool result carries only the file path. */
  saveNoteImage?: (bytes: Uint8Array) => Promise<string>;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";

/** Per-request factory: `paths` collects files generated during ONE converse() call, so the
 * calling surface renders/uploads them without parsing the model's reply text. Build a fresh
 * one per turn — a shared instance would leak paths across requests. */
export function makeGenerateImageTool(deps: ImageGenDeps): { tool: ActionTool; paths: string[] } {
  const paths: string[] = [];
  const tool: ActionTool = {
    spec: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt and show it to the user. Use when the user asks " +
        "you to draw, create, or make an image/picture/logo/illustration. Generation takes up " +
        "to a minute — the surface shows a progress indicator, don't apologize for the wait.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "detailed description of the image to generate" } },
        required: ["prompt"],
      },
    },
    run: async (args: unknown): Promise<string> => {
      const prompt = (args as { prompt?: unknown })?.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) return "error: generate_image needs a non-empty prompt";
      deps.onStart?.();
      try {
        const { b64 } = await deps.generate({ model: deps.model, prompt });
        await mkdir(deps.imagesDir, { recursive: true });
        // UUID chunk: concurrent generations with matching prompt slugs in the same
        // millisecond must not race writeFile into the same path.
        const file = join(deps.imagesDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${slug(prompt)}.png`);
        const bytes = Buffer.from(b64, "base64");
        await writeFile(file, bytes);
        paths.push(file);
        // Best-effort: the image is already generated and shown, so a failed note-image insert
        // only drops the embed hint rather than reporting the whole generation as failed.
        const id = await deps.saveNoteImage?.(bytes).catch(() => undefined);
        const embed = id ? ` To embed it in a note, use ![short description](bean-image:${id}).` : "";
        return `Image generated and saved to ${file}. It is already shown to the user — describe it in one short sentence.${embed}`;
      } catch (err) {
        return `error: image generation failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
  return { tool, paths };
}

// The concrete OpenAI Images adapter (makeOpenAIImageGen) lives in openai-chat.ts — the one
// module allowed to touch the real SDK; this module stays pure and dependency-injected.
