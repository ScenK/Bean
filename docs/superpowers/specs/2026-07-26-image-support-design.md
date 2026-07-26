# Image Support (Recognition + Generation) — Design

**Date:** 2026-07-26
**Status:** Approved (approach A; sections 3–5 delegated to agent judgment)

## Goal

Bean can *see* images the user sends (desktop ChatWindow, Discord, Teams) and *make*
images on request via an OpenAI Images API call, across the same three surfaces.
Routines/delegate are out of scope.

## Facts

- Bean's brain model (`gpt-5.4-nano`, configurable) accepts text + image **input**,
  outputs text only. Recognition needs no model change.
- Generation requires a separate Images API call (`gpt-image-1`).

## Section 1 — Core types + chat adapter

- `ConvoMsg` **user** content becomes `string | ContentPart[]`:
  `ContentPart = { type: "text"; text: string } | { type: "image"; data: string /* base64, no data: prefix */; mimeType: string }`.
  System / assistant / tool messages stay `string`.
- `openai-chat.ts` `toOpenAIMessage()` maps image parts to OpenAI
  `{ type: "image_url", image_url: { url: "data:<mime>;base64,<data>" } }` parts.
- **Latest-turn-only:** `ConverseInput.latestUserImages?: ImageAttachment[]` attaches
  images to the current user turn only. `ChatTurn` (history) stays text — surfaces store
  a `[image attached]` placeholder. No trimming code needed; token cost capped by
  construction. Ceiling: multi-turn follow-ups about the same image lose the pixels
  (the model keeps its own prior text description). Upgrade path: widen `ChatTurn` if
  that ever matters.

## Section 2 — Generation

- New core module `image-gen.ts`: `generateImage(deps, { prompt, size? })` — DI'd
  (`deps.generate` injectable for tests; real impl calls OpenAI Images API with
  model `gpt-image-1`), writes PNG to `~/.bean/images/<timestamp>-<slug>.png`,
  returns `{ path }`.
- `converse()` gains a `generate_image` **action tool** (`{ prompt: string }`) —
  executes inline in the tool loop like `system_control`; tool result is the file
  path (or error string). Offered only when deps provide a generate fn.
- `ConverseResult` gains `generatedImages?: string[]` (absolute paths) so surfaces
  render without parsing reply text.
- Config: reuses `openaiApiKey`; image model comes from `~/.bean/config.json`'s new
  `imageModel` key, defaulting to `gpt-image-2` (user decision — no hardcoded model).
- Errors: API failure → error string as tool result; `converse()` never throws.
- **Slow-generation feedback (user decision):** the tool factory takes an optional
  `onStart` callback fired when generation begins. Desktop: pushed over IPC to flip the
  chat's working bubble to "🎨 Painting…". Discord/Teams: the bot posts
  "🎨 Working on your image — this can take a minute…" as a message.

## Section 3 — Desktop ChatWindow

- Ingest: paste and drag-drop of image files/clipboard images in the chat input.
  Renderer reads bytes, base64-encodes, sends parts over the existing `bean:chat`
  IPC (payload shape extended; channel names stay in `channels.ts`).
- Limits: `image/*` only, ≤ 10 MB per image, enforced in renderer with a visible
  error message.
- Display: user-sent images shown as thumbnails in the sent bubble; generated
  images rendered inline as `data:` URLs (main process reads the PNG and returns a
  data URL over IPC — avoids `file://` webSecurity issues). Click = open file in
  default viewer (`shell.openPath`).

## Section 4 — Discord / Teams bots

- Ingest: message attachments with `content-type: image/*` and ≤ 10 MB are
  downloaded and attached as image parts on that user turn. Non-image or oversized
  attachments ignored (existing text flow unaffected).
- Egress: new `BotEffects.sendFile(path, caption?)` effect. Discord: native
  attachment upload. Teams: inline base64 image in the activity/card.
- Shared logic (size/type filter, base64 packing) lives in core `chatops/`; each
  surface only fetches bytes with its own SDK.

## Section 5 — History / persistence

- SQLite chatops history and desktop conversation persistence store a `[image]`
  placeholder in the text, never blobs or base64.
- Generated images persist as files under `~/.bean/images/` (no cleanup policy yet;
  add one if it ever matters).
- In-memory conversation keeps image parts (subject to the Section 1 send-time
  trimming); restarts lose image bytes — acceptable.

## Testing

- Core: vitest with fake `ToolChatClient` asserting image parts map to `image_url`
  data URLs; fake `generate` asserting tool loop wiring + `generatedImages`;
  trimming test (turn 5+ images become `[image omitted]`).
- Chatops: fake effects asserting attachment ingest filter and `sendFile` calls.
- App: `buildChatHandler` test with image parts payload.
- Validation gate: `pnpm test && pnpm typecheck`; packaged smoke via `pnpm dist:mac`
  before claiming done (touches IPC/preload/renderer).

## Out of scope (YAGNI)

- Routines/delegate image steps; image editing/variations; blob persistence;
  configurable image model/size UI; image content in FTS search.
