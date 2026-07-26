# Image Support (Recognition + Generation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bean sees images the user sends (desktop ChatWindow, Discord, Teams) and generates images on request via the OpenAI Images API.

**Architecture:** Widen `ConvoMsg` user content to text+image parts (recognition); add a per-turn `generate_image` action tool built by a factory that collects generated file paths (generation). Each surface handles its own ingest (paste/drop, attachments) and egress (inline data URL, native attachment).

**Tech Stack:** TypeScript ESM monorepo (pnpm + turbo), vitest, OpenAI SDK (chat + images), Electron (app), discord.js, botbuilder (Teams).

**Spec:** `docs/superpowers/specs/2026-07-26-image-support-design.md`

## Global Constraints

- `pnpm test && pnpm typecheck` must exit 0 before claiming done (run from repo root).
- `@bean/core` stays Electron-free and dependency-injected (`.memory/convention-core-is-electron-free.md`).
- ESM: relative imports use `.js` extensions; `import type` for type-only imports.
- `strict` + `noUncheckedIndexedAccess` — array access is `T | undefined`.
- IPC channel names only in `packages/app/src/channels.ts` (`.memory/convention-ipc-channels.md`).
- Image ingest limits everywhere: `image/*` MIME only, ≤ 10 MB per image.
- Image model comes from config `imageModel`, default `"gpt-image-2"` — never hardcoded at call sites.
- New core exports go through `packages/core/src/index.ts`.
- Commit after each task with a conventional-commit message.

---

### Task 1: Core — multimodal user messages + OpenAI adapter mapping

**Files:**
- Modify: `packages/core/src/converse.ts:9-12` (ConvoMsg type)
- Modify: `packages/core/src/openai-chat.ts` (ToolChatClient message type + `toOpenAIMessage`)
- Test: `packages/core/__test__/openai-chat.test.ts` (exists — add cases)

**Interfaces:**
- Produces: `ImageAttachment { data: string; mimeType: string }` (base64 payload, NO `data:` prefix), `UserContentPart = { type: "text"; text: string } | { type: "image"; image: ImageAttachment }`, both exported from `converse.ts` and re-exported from `index.ts`. `ConvoMsg` user variant becomes `{ role: "user"; content: string | UserContentPart[] }`.

- [ ] **Step 1: Write failing tests** in `packages/core/__test__/openai-chat.test.ts`:

```ts
it("maps user image parts to image_url data URLs", async () => {
  let captured: unknown;
  const client = { chat: { completions: { create: async (args: unknown) => { captured = args; return { choices: [{ message: { content: "ok" } }] }; } } } };
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({
    model: "m",
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image", image: { data: "AAAA", mimeType: "image/png" } },
    ] }],
    tools: [],
  });
  const msg = (captured as { messages: Array<{ content: unknown }> }).messages[0];
  expect(msg?.content).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
});

it("passes plain-string user content through unchanged", async () => {
  let captured: unknown;
  const client = { chat: { completions: { create: async (args: unknown) => { captured = args; return { choices: [{ message: { content: "ok" } }] }; } } } };
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  expect((captured as { messages: Array<{ content: unknown }> }).messages[0]?.content).toBe("hi");
});
```

- [ ] **Step 2: Run** `pnpm --filter @bean/core exec vitest run __test__/openai-chat.test.ts` — expect FAIL (type error / wrong shape).

- [ ] **Step 3: Implement.** In `converse.ts` replace the `ConvoMsg` block:

```ts
/** Base64 image payload (no data: prefix). */
export interface ImageAttachment { data: string; mimeType: string }
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageAttachment };
export type ConvoMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
```

In `openai-chat.ts`, widen the user variant of `ToolChatClient`'s message union to
`{ role: "system"; content: string } | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }`
(split the current combined `"system" | "user"` member), and in `toOpenAIMessage` add before the final return:

```ts
if (message.role === "user" && Array.isArray(message.content)) {
  return {
    role: "user",
    content: message.content.map((p) =>
      p.type === "text"
        ? { type: "text" as const, text: p.text }
        : { type: "image_url" as const, image_url: { url: `data:${p.image.mimeType};base64,${p.image.data}` } }),
  };
}
```

Export `ImageAttachment` and `UserContentPart` from `packages/core/src/index.ts` (add to the existing `converse.js` export line).

- [ ] **Step 4: Run** the same test file — expect PASS. Then `pnpm --filter @bean/core test && pnpm --filter @bean/core typecheck`.

- [ ] **Step 5: Commit** `feat(core): multimodal user messages mapped to OpenAI image_url parts`

---

### Task 2: Core — converse() accepts latest-turn images

**Files:**
- Modify: `packages/core/src/converse.ts` (`ConverseInput`, final user message build at line ~388)
- Test: `packages/core/__test__/converse.test.ts` (exists — add case)

**Interfaces:**
- Consumes: `ImageAttachment`, `UserContentPart` (Task 1).
- Produces: `ConverseInput.latestUserImages?: ImageAttachment[]`. Only the LATEST user turn carries image parts — history stays text (`ChatTurn` unchanged; surfaces store a `[image attached]` placeholder). This is the deliberate latest-turn-only simplification from the spec.

- [ ] **Step 1: Write failing test** in `converse.test.ts` (reuse the file's existing fake-deps pattern for a plain text reply):

```ts
it("sends latest-turn images as content parts", async () => {
  let captured: ConvoMsg[] = [];
  const deps = { model: "m", chat: async (a: { messages: ConvoMsg[] }) => { captured = a.messages; return { content: "a cat", toolCalls: [] }; } };
  await converse({
    history: [], latestUserText: "what is this?", skills: [], projects: [],
    persona: blankPersona(), memories: [], deps,
    latestUserImages: [{ data: "AAAA", mimeType: "image/jpeg" }],
  });
  const last = captured[captured.length - 1];
  expect(last).toEqual({ role: "user", content: [
    { type: "text", text: "what is this?" },
    { type: "image", image: { data: "AAAA", mimeType: "image/jpeg" } },
  ] });
});
```

(Match the persona/skill fixture helpers already used in that file — if there is no `blankPersona()`, inline whatever minimal `Persona` object the other tests use.)

- [ ] **Step 2: Run** `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts` — expect FAIL.

- [ ] **Step 3: Implement.** Add `latestUserImages?: ImageAttachment[]` to `ConverseInput`, destructure it (default `[]`), and replace the final message element:

```ts
{ role: "user", content: latestUserImages.length > 0
    ? [{ type: "text" as const, text: latestUserText }, ...latestUserImages.map((image) => ({ type: "image" as const, image }))]
    : latestUserText },
```

- [ ] **Step 4: Run** test file — PASS; then package test + typecheck.
- [ ] **Step 5: Commit** `feat(core): converse() accepts latest-turn image attachments`

---

### Task 3: Core — `imageModel` config + `imagesDir` helper

**Files:**
- Modify: `packages/core/src/types.ts` (`BeanConfig`)
- Modify: `packages/core/src/config.ts` (`loadConfig` default, `saveConfig` preserve, `imagesDir`)
- Test: `packages/core/__test__/config.test.ts` (exists — add cases)

**Interfaces:**
- Produces: `BeanConfig.imageModel: string` (default `"gpt-image-2"`); `imagesDir(dir: string): string` → `<dir>/images`, exported from `config.ts` and `index.ts`.

- [ ] **Step 1: Write failing tests** in `config.test.ts` (follow its existing temp-file pattern):

```ts
it("defaults imageModel to gpt-image-2", async () => { /* write config.json without imageModel, loadConfig, expect cfg.imageModel === "gpt-image-2" */ });
it("preserves imageModel across a saveConfig that omits it", async () => { /* write {imageModel:"custom"}, saveConfig without the field, reload, expect "custom" */ });
it("imagesDir joins dir/images", () => { expect(imagesDir("/x")).toBe(join("/x", "images")); });
```

Write these as real tests using the file's existing tmpdir helpers — no placeholders in the committed test code.

- [ ] **Step 2: Run** `pnpm --filter @bean/core exec vitest run __test__/config.test.ts` — FAIL.

- [ ] **Step 3: Implement.** `types.ts`: add `imageModel: string;` to `BeanConfig`. `config.ts`:
  - `loadConfig` return: `imageModel: parsed.imageModel ?? "gpt-image-2",`
  - `saveConfig`: no Settings UI sends it, so preserve like `liveSessions`: add `imageModel: config.imageModel ?? existing.imageModel ?? "gpt-image-2",` to `out` (and the optional field to `saveConfig`'s param type).
  - Add `export function imagesDir(dir: string): string { return join(dir, "images"); }` and export from `index.ts`.

- [ ] **Step 4: Run** tests — PASS; package test + typecheck.
- [ ] **Step 5: Commit** `feat(core): imageModel config (default gpt-image-2) and imagesDir helper`

---

### Task 4: Core — image generation module + action-tool factory

**Files:**
- Create: `packages/core/src/image-gen.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/__test__/image-gen.test.ts` (new)

**Interfaces:**
- Consumes: `ActionTool` from `converse.js`.
- Produces (exact, later tasks depend on these):

```ts
export interface ImageGenDeps {
  generate: (args: { model: string; prompt: string }) => Promise<{ b64: string }>;
  model: string;
  imagesDir: string;
  /** Fired when a generation actually starts — surfaces show a "🎨 working" indicator. */
  onStart?: () => void;
}
/** Per-request factory: `paths` collects files generated during ONE converse() call. */
export function makeGenerateImageTool(deps: ImageGenDeps): { tool: ActionTool; paths: string[] }
export function makeOpenAIImageGen(apiKey: string): ImageGenDeps["generate"]
```

- [ ] **Step 1: Write failing tests** `packages/core/__test__/image-gen.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeGenerateImageTool } from "../src/image-gen.js";

describe("makeGenerateImageTool", () => {
  it("writes the PNG, collects the path, fires onStart, returns the path in the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bean-img-"));
    const onStart = vi.fn();
    const { tool, paths } = makeGenerateImageTool({
      generate: async ({ model, prompt }) => {
        expect(model).toBe("gpt-image-2");
        expect(prompt).toBe("a red cat");
        return { b64: Buffer.from("png-bytes").toString("base64") };
      },
      model: "gpt-image-2", imagesDir: dir, onStart,
    });
    const result = await tool.run({ prompt: "a red cat" });
    expect(onStart).toHaveBeenCalledOnce();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/a-red-cat\.png$/);
    expect((await readFile(paths[0]!)).toString()).toBe("png-bytes");
    expect(result).toContain(paths[0]!);
  });

  it("returns an error string instead of throwing when the API fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bean-img-"));
    const { tool, paths } = makeGenerateImageTool({
      generate: async () => { throw new Error("quota exceeded"); },
      model: "gpt-image-2", imagesDir: dir,
    });
    const result = await tool.run({ prompt: "x" });
    expect(result).toContain("quota exceeded");
    expect(paths).toHaveLength(0);
  });

  it("rejects a missing prompt without calling the API", async () => {
    const generate = vi.fn();
    const { tool } = makeGenerateImageTool({ generate, model: "m", imagesDir: "/nope" });
    const result = await tool.run({});
    expect(result).toMatch(/prompt/i);
    expect(generate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @bean/core exec vitest run __test__/image-gen.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** `packages/core/src/image-gen.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import type { ActionTool } from "./converse.js";

export interface ImageGenDeps {
  generate: (args: { model: string; prompt: string }) => Promise<{ b64: string }>;
  model: string;
  imagesDir: string;
  /** Fired when a generation actually starts — surfaces show a "🎨 working" indicator. */
  onStart?: () => void;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";

/** Per-request factory: `paths` collects files generated during one converse() call,
 * so surfaces render/upload them without parsing the model's reply text. */
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
        const file = join(deps.imagesDir, `${Date.now()}-${slug(prompt)}.png`);
        await writeFile(file, Buffer.from(b64, "base64"));
        paths.push(file);
        return `Image generated and saved to ${file}. It is already shown to the user — describe it in one short sentence.`;
      } catch (err) {
        return `error: image generation failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
  return { tool, paths };
}

interface ImageClient { images: { generate: (a: { model: string; prompt: string }) => Promise<{ data?: Array<{ b64_json?: string }> }> } }

export function makeOpenAIImageGenWithClient(client: ImageClient): ImageGenDeps["generate"] {
  return async ({ model, prompt }) => {
    const res = await client.images.generate({ model, prompt });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Images API returned no image data");
    return { b64 };
  };
}

export function makeOpenAIImageGen(apiKey: string): ImageGenDeps["generate"] {
  return makeOpenAIImageGenWithClient(new OpenAI({ apiKey }) as unknown as ImageClient);
}
```

Export everything from `index.ts`: `export * from "./image-gen.js";`

- [ ] **Step 4: Run** tests — PASS; package test + typecheck.
- [ ] **Step 5: Commit** `feat(core): generate_image action tool + OpenAI Images adapter`

---

### Task 5: Core — chatops bot ingest/egress + generation wiring

**Files:**
- Modify: `packages/core/src/chatops/bot.ts` (`IncomingMessage`, `BotEffects`, `TeamsBotDeps`, `onMessage`)
- Test: `packages/core/__test__/chatops-bot.test.ts` (exists — add cases; extend its fake deps/effects fixtures)

**Interfaces:**
- Consumes: `ImageAttachment` (Task 1), `makeGenerateImageTool`/`ImageGenDeps` (Task 4), `ConverseInput.latestUserImages` (Task 2).
- Produces:
  - `IncomingMessage.images?: ImageAttachment[]` (surfaces fill it from attachments).
  - `BotEffects.sendFile?: (path: string, caption?: string) => Promise<void>`.
  - `TeamsBotDeps.imageGen?: { generate: ImageGenDeps["generate"]; model: string; imagesDir: string }`.

- [ ] **Step 1: Write failing tests** in `chatops-bot.test.ts` (reuse its existing `makeDeps`/`makeEffects` helpers — extend, don't fork):

```ts
it("passes incoming images to converse and stores a placeholder in history", async () => {
  // deps.chat fake captures the messages it receives
  // bot.onMessage({ ...msg, text: "what is this?", images: [{ data: "AAAA", mimeType: "image/png" }] }, fx)
  // expect last captured user message content to be the two-part array (text + image)
  // expect conversations.history(...) latest user turn content to be "what is this?\n[image attached]"
});

it("generates an image via the tool and sends it with sendFile, posting a working notice", async () => {
  // deps.imageGen = { generate: async () => ({ b64: Buffer.from("x").toString("base64") }), model: "gpt-image-2", imagesDir: tmpdir }
  // deps.chat fake: first call returns { content: "", toolCalls: [{ id: "1", name: "generate_image", args: { prompt: "a cat" } }] },
  //                 second call returns { content: "here you go", toolCalls: [] }
  // fx.sendFile = vi.fn(); fx.post records texts
  // await bot.onMessage(msg, fx)
  // expect fx.post to have received the "🎨 Working on your image" notice
  // expect fx.sendFile called once with a path ending .png
});
```

Flesh both out against the file's real fixture helpers — committed tests must be complete and passing-shaped, not comments.

- [ ] **Step 2: Run** `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts` — FAIL.

- [ ] **Step 3: Implement** in `bot.ts`:
  - Types: add the three interface fields above (`import { makeGenerateImageTool } from "../image-gen.js";` and `import type { ImageAttachment } from "../converse.js";`).
  - In `onMessage`, right before `const result = await converse(...)` (line ~574): build the per-turn tool:

```ts
const imageTool = deps.imageGen
  ? makeGenerateImageTool({
      ...deps.imageGen,
      onStart: () => { void fx.post("🎨 Working on your image — this can take a minute…"); },
    })
  : undefined;
```

  - Pass to converse: `actions: imageTool ? [...actions, imageTool.tool] : actions` (the `converseBase` object) and `latestUserImages: msg.images` on the main call (NOT the `target: chat` follow-up hop).
  - History placeholder: change the user append (line ~575) to
    `deps.conversations.append(msg.conversationId, { role: "user", content: msg.images?.length ? `${msg.text}\n[image attached]` : msg.text });`
  - After the reply is posted (after the `if (result.reply)` block), deliver generated files:

```ts
for (const p of imageTool?.paths ?? []) {
  if (fx.sendFile) await fx.sendFile(p);
  else await fx.post(`(image saved to ${p} — this surface can't display it)`);
}
```

- [ ] **Step 4: Run** tests — PASS; `pnpm --filter @bean/core test && pnpm --filter @bean/core typecheck`.
- [ ] **Step 5: Commit** `feat(core): chatops image ingest, generate_image wiring, sendFile egress`

---

### Task 6: App — chat handler + IPC + main wiring

**Files:**
- Modify: `packages/core/src/converse.ts` (`ChatRequest.images`, `ConverseResult.generatedImages` — type only, converse never sets it)
- Modify: `packages/app/src/ipc.ts` (`ChatHandlerDeps.imageGen`, `buildChatHandler`)
- Modify: `packages/app/src/channels.ts` (new `chatImageProgress` channel)
- Modify: `packages/app/src/main.ts` (wire `imageGen` into `registerIpc`)
- Modify: `packages/app/src/preload.ts` (`onChatImageProgress`)
- Modify: `packages/app/src/renderer/bean.d.ts` (window.bean type)
- Test: `packages/app/__test__/ipc.test.ts` (or wherever `buildChatHandler` is tested — `grep -rn buildChatHandler packages/app/__test__/`)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `ChatRequest.images?: ImageAttachment[]` (core type; preload passes it opaquely — no preload change for ingest).
  - `ConverseResult.generatedImages?: Array<{ path: string; dataUrl?: string }>` (core type; desktop handler fills `dataUrl`, chatops ignores the field entirely — bots use `sendFile`).
  - `ChatHandlerDeps.imageGen?: { generate: ImageGenDeps["generate"]; getModel: () => string; imagesDir: string; onStart?: () => void }`.
  - IPC: `IPC.chatImageProgress` push channel (main → chat window), preload `onChatImageProgress(cb: () => void)`.

- [ ] **Step 1: Write failing test** for the handler (in the app package's existing `buildChatHandler` test file):

```ts
it("runs generate_image and returns generatedImages with data URLs", async () => {
  // deps.converse fake: first call returns generate_image toolCall, second returns plain reply
  // (mirror Task 5's two-call fake)
  // deps.imageGen = { generate: async () => ({ b64: Buffer.from("png!").toString("base64") }), getModel: () => "gpt-image-2", imagesDir: mkdtemp(...) }
  // res = await handler({ history: [], message: "draw a cat" })
  // expect(res.generatedImages).toHaveLength(1)
  // expect(res.generatedImages![0]!.dataUrl).toBe(`data:image/png;base64,${Buffer.from("png!").toString("base64")}`)
});
it("forwards req.images to converse as latestUserImages", async () => { /* capture converse input, assert */ });
```

Write complete test bodies against the file's existing fake-deps pattern.

- [ ] **Step 2: Run** the app test file — FAIL.

- [ ] **Step 3: Implement.**
  - `converse.ts`: `ChatRequest` gains `images?: ImageAttachment[]`; `ConverseResult` gains `generatedImages?: Array<{ path: string; dataUrl?: string }>` with a doc comment: set by surface handlers (never by `converse()` itself).
  - `ipc.ts` `buildChatHandler`:

```ts
const imageTool = deps.imageGen
  ? makeGenerateImageTool({
      generate: deps.imageGen.generate,
      model: deps.imageGen.getModel(),
      imagesDir: deps.imageGen.imagesDir,
      onStart: deps.imageGen.onStart,
    })
  : undefined;
const result = await converse({
  ...existing args...,
  latestUserImages: req.images,
  actions: imageTool ? [...(deps.actions ?? []), imageTool.tool] : deps.actions,
});
if (imageTool && imageTool.paths.length > 0) {
  result.generatedImages = await Promise.all(imageTool.paths.map(async (path) => ({
    path,
    dataUrl: `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
  })));
}
return result;
```

  (`import { readFile } from "node:fs/promises";` — ipc.ts already runs in main.)
  - `channels.ts`: add `chatImageProgress: "bean:chat-image-progress"` to `IPC`.
  - `main.ts`: in the `registerIpc` deps add:

```ts
imageGen: {
  generate: (a) => makeOpenAIImageGen(runtime.getApiKey())(a),
  getModel: () => beanConfig.imageModel,
  imagesDir: imagesDir(dir),
  onStart: () => { chatWindow()?.webContents.send(IPC.chatImageProgress); },
},
```

  Use whatever accessor main.ts already uses to reach the chat BrowserWindow (grep `webContents.send` in main.ts/windows.ts and mirror it; guard null). `beanConfig` is the boot-time loaded config already in scope — imageModel has no Settings UI, so boot-time capture is fine (`// ponytail: imageModel read at boot; move into runtime-config if a Settings field ever exists`).
  - `preload.ts`: `onChatImageProgress: (cb: () => void) => ipcRenderer.on(IPC.chatImageProgress, () => cb()),`
  - `bean.d.ts`: add matching method signature.

- [ ] **Step 4: Run** app tests + typecheck (`pnpm --filter @bean/app test && pnpm --filter @bean/app typecheck`), plus core typecheck (types changed).
- [ ] **Step 5: Commit** `feat(app): image chat handler — ingest passthrough, generation, progress push`

---

### Task 7: App renderer — paste/drop ingest, thumbnails, generated display

**Files:**
- Modify: `packages/app/src/renderer/shared/chat-types.ts` (ChatItem)
- Modify: `packages/app/src/renderer/components/chat/ChatWindow.tsx` (sendMessage plumbing, progress listener)
- Modify: `packages/app/src/renderer/components/chat/ChatPanel.tsx` (composer paste/drop, pending-image chips, bubble rendering)
- Modify: `packages/app/src/renderer/shared.css` or the chat CSS the components already use (thumbnail styles)
- Test: `packages/app/__test__/` — add a pure-function test for the new `fileToAttachment` guard (size/type), colocated with existing renderer helper tests if any exist (`grep -rn "chat-types" packages/app/__test__/`); UI wiring itself is not unit-tested (matches existing codebase practice).

**Interfaces:**
- Consumes: `ImageAttachment`, `ChatRequest.images`, `ConverseResult.generatedImages`, `window.bean.onChatImageProgress` (Task 6).
- Produces (renderer-internal):
  - `ChatItem` `user` variant gains `images?: string[]` (data URLs for thumbnails); `reply` variant gains `images?: Array<{ path: string; dataUrl: string }>`.
  - `ChatPanel` prop `onSend` becomes `(text: string, images?: ImageAttachment[]) => void`.
  - Exported helper in `chat-types.ts`: `imageFileGuard(type: string, size: number): string | null` returning an error message or null (pure, testable).

- [ ] **Step 1: Write failing test** for the guard:

```ts
it("rejects non-images and >10MB files", () => {
  expect(imageFileGuard("application/pdf", 100)).toMatch(/image/i);
  expect(imageFileGuard("image/png", 11 * 1024 * 1024)).toMatch(/10 ?MB/i);
  expect(imageFileGuard("image/png", 1024)).toBeNull();
});
```

- [ ] **Step 2: Run** — FAIL. Implement in `chat-types.ts`:

```ts
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function imageFileGuard(type: string, size: number): string | null {
  if (!type.startsWith("image/")) return "Only image files can be attached.";
  if (size > MAX_IMAGE_BYTES) return "Images must be 10 MB or smaller.";
  return null;
}
```

Run — PASS.

- [ ] **Step 3: Implement the UI wiring** (no test; verify in Step 4 via typecheck/build + Step 5 smoke):
  - `chat-types.ts`: add the `images` fields to the `user` and `reply` ChatItem variants.
  - `ChatPanel.tsx` composer: keep `pendingImages: Array<{ attachment: ImageAttachment; dataUrl: string }>` state. On `onPaste` (clipboard items with `type.startsWith("image/")`) and on the existing `onDrop` handler (extend `dropPathIntoComposer`'s file branch: image files become attachments instead of inserted paths): run `imageFileGuard`, show its message as the panel's existing error/status affordance on reject, else `FileReader.readAsDataURL` → strip the `data:<mime>;base64,` prefix for the `ImageAttachment`, keep the full string as thumbnail `dataUrl`. Render chips (thumbnail + ✕ remove) above the textarea. Send button calls `onSend(text, pendingImages.map((p) => p.attachment))` and clears them. Allow image-only sends (text may be empty when images exist — pass a fixed text like `"(image)"` if empty so converse always has text).
  - `ChatWindow.tsx`:
    - `sendMessage(text, display?, queueIfBusy?, images?: ImageAttachment[])`: include user item `images: images?.map(dataUrlOf)` (rebuild the data URL from attachment for the thumbnail), pass `images` into `window.bean.chat({ ... , images })`, and append `\n[image attached]` to the history `content` for user turns that carried images (mirror chatops).
    - On response: `if (res.generatedImages?.length) next.push({ kind: "reply", ..., text: res.reply, images: res.generatedImages.filter((g): g is {path:string;dataUrl:string} => !!g.dataUrl) })` — fold into the existing reply push rather than a second bubble.
    - Progress: in the mount effect, `window.bean.onChatImageProgress(() => setItems((prev) => prev.map((it) => it.kind === "working" ? { ...it, text: "🎨 Painting…" } : it)));`
  - Bubble rendering in `ChatPanel.tsx`: user bubbles map `images` to `<img class="bean-chat-thumb" src={dataUrl} />`; reply bubbles same plus `onClick={() => window.bean.revealInFinder(img.path)}` (reuses the existing preload method — no new IPC).
  - CSS: `.bean-chat-thumb { max-width: 200px; max-height: 200px; border-radius: 8px; display: block; margin-top: 6px; cursor: pointer; }`

- [ ] **Step 4: Run** `pnpm --filter @bean/app test && pnpm --filter @bean/app typecheck && pnpm build` (build catches renderer bundling issues — `.memory/convention-renderer-imports-node-free-subpaths.md`: import `ImageAttachment` as a TYPE-ONLY import from `@bean/core`, which is safe).
- [ ] **Step 5: Smoke** `pnpm dev`: paste a screenshot into chat, ask "what is this?"; ask "draw a red cat", watch bubble flip to 🎨 and the image render. Requires a real `~/.bean/config.json` key — if unavailable, note it and defer to the Task 10 verification gate.
- [ ] **Step 6: Commit** `feat(app): chat image paste/drop, thumbnails, generated-image display`

---

### Task 8: Discord — attachments in, files out

**Files:**
- Modify: `packages/discord/src/server.ts` (`messageCreate` ingest, `effectsFor` sendFile, bot deps imageGen)
- Test: `packages/discord/__test__/` — check what exists (`ls packages/discord/__test__/`); add a unit test only if an ingest helper is extracted (extract `attachmentToImage(contentType, size, fetchBytes)` if the file has any test coverage pattern; otherwise rely on core tests + smoke, matching the surface's existing test posture).

**Interfaces:**
- Consumes: `IncomingMessage.images`, `BotEffects.sendFile`, `TeamsBotDeps.imageGen` (Task 5), `makeOpenAIImageGen`, `imagesDir`, `beanConfig.imageModel` (Tasks 3–4).

- [ ] **Step 1: Implement ingest** in the `messageCreate` handler (after `text` extraction; an image with no text should still get a turn, so relax the `if (!text) return;` guard to `if (!text && images.length === 0) return;` and pass `text || "(image)"`):

```ts
const images: ImageAttachment[] = [];
for (const att of message.attachments.values()) {
  if (!att.contentType?.startsWith("image/") || att.size > 10 * 1024 * 1024) continue;
  try {
    const res = await fetch(att.url);
    images.push({ data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: att.contentType });
  } catch (err) { console.error("attachment fetch failed:", err); }
}
```

Pass `images: images.length > 0 ? images : undefined` in the `bot.onMessage` payload.

- [ ] **Step 2: Implement egress** in `effectsFor`:

```ts
sendFile: async (path, caption) => { await send({ content: caption ?? "", files: [path] }); },
```

- [ ] **Step 3: Wire generation** in the `buildTeamsBot` deps:

```ts
imageGen: { generate: makeOpenAIImageGen(beanConfig.openaiApiKey), model: beanConfig.imageModel, imagesDir: imagesDir(dir) },
```

(add `imagesDir`, `makeOpenAIImageGen`, `type ImageAttachment` to the `@bean/core` import).

- [ ] **Step 4: Run** `pnpm --filter @bean/discord test && pnpm --filter @bean/discord typecheck`.
- [ ] **Step 5: Commit** `feat(discord): image attachments in, generated images out`

---

### Task 9: Teams — attachments in, inline image out

**Files:**
- Modify: `packages/teams/src/server.ts`
- Test: `packages/teams/__test__/` — same posture as Task 8.

**Interfaces:**
- Consumes: same as Task 8.

- [ ] **Step 1: Implement ingest** in the `/api/messages` handler before `bot.onMessage`. Teams inline images arrive as `a.attachments` with `contentType: "image/*"` and a `contentUrl` on the SMBA endpoint that requires the bot's bearer token:

```ts
async function downloadImages(a: Activity): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = [];
  for (const att of a.attachments ?? []) {
    if (!att.contentType?.startsWith("image/") || !att.contentUrl) continue;
    try {
      const creds = await credentialsFactory.createCredentials(teamsConfig.botAppId, "https://api.botframework.com", "https://login.microsoftonline.com", true);
      const token = await (creds as { getToken: () => Promise<string> }).getToken();
      const res = await fetch(att.contentUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 10 * 1024 * 1024) continue;
      out.push({ data: buf.toString("base64"), mimeType: att.contentType });
    } catch (err) { console.error("teams attachment download failed:", err); }
  }
  return out;
}
```

**Verify the credentials call shape against the installed botbuilder version at implementation time** (`node -e` probe or read `node_modules/botframework-connector` typings) — the `createCredentials` signature above is from botbuilder 4.23; if it differs, get the token however the installed version exposes it (this is the one integration point the plan can't pin from source). Same empty-turn relaxation as Discord: image-only messages get `text || "(image)"`.

- [ ] **Step 2: Implement egress** in `effectsFor` (Teams renders base64 `contentUrl` images inline):

```ts
sendFile: async (path, caption) => {
  const b64 = (await readFile(path)).toString("base64");
  await proactive(async (ctx) => {
    await ctx.sendActivity({
      type: ActivityTypes.Message,
      text: caption ?? "",
      attachments: [{ contentType: "image/png", contentUrl: `data:image/png;base64,${b64}`, name: basename(path) }],
    });
  });
},
```

(`readFile` is already imported in this file; add `basename` to the `node:path` import.)

- [ ] **Step 3: Wire generation** — same `imageGen` deps block as Discord Task 8 Step 3.
- [ ] **Step 4: Run** `pnpm --filter @bean/teams test && pnpm --filter @bean/teams typecheck`.
- [ ] **Step 5: Commit** `feat(teams): image attachments in, inline generated images out`

---

### Task 10: Full validation + memory entry

**Files:**
- Create: `.memory/project-image-support.md`; modify `.memory/INDEX.md`
- Modify: `docs/superpowers/specs/2026-07-26-image-support-design.md` if implementation diverged

- [ ] **Step 1:** `pnpm test && pnpm typecheck` from root — both exit 0.
- [ ] **Step 2:** `pnpm build` — renderer bundle clean.
- [ ] **Step 3 (packaged check — required by AGENTS.md, this change touches IPC/preload/renderer):** `pnpm dist:mac`, launch `packages/app/release/mac-*/Bean.app`, paste an image into chat and ask about it; ask for a generated image. Quit stale Bean instances first.
- [ ] **Step 4:** Write `.memory/project-image-support.md` (a short paragraph: latest-turn-only image context, per-request `makeGenerateImageTool` collector pattern, `imageModel` config default gpt-image-2, Teams token-authenticated attachment download) and link from `INDEX.md` under project.
- [ ] **Step 5: Commit** `docs(memory): image support entry` (fold spec fixes in if any).
