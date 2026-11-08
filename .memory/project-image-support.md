# Image support (recognition + generation)

- **Recognition is latest-turn-only.** `ConverseInput.latestUserImages` attaches images to
  the current user turn; `ChatTurn`/history stays text with a `[image attached]` placeholder
  (all surfaces do this). Deliberate ceiling: multi-turn follow-ups about the same image lose
  the pixels — widen `ChatTurn` only if that ever matters. Never store base64 in bean.db — note images (#182) are
  raw BLOBs in their own `note_images` table, referenced by id, so prompt/search/history rows stay small.
  Main re-checks renderer-sent images (`checkImageAttachments`: list, ≤4, png/jpeg/webp, ≤10 MB by base64
  length) in the desktop chat handler and `stageImages` — the renderer's `imageFileGuard` is UX only (#733).
- **Generation is a per-request tool.** `makeGenerateImageTool()` (core `image-gen.ts`) must
  be built fresh per converse() call — its `paths` array collects that one turn's generated
  files (a shared instance leaks paths across requests). `converse()` never sets
  `ConverseResult.generatedImages`; surface handlers do (desktop fills `dataUrl`; bots use
  `BotEffects.sendFile` instead — Discord native upload). **Teams deliberately has no
  `sendFile`**: inline base64 exceeds Teams activity size limits, and hosting the file
  (public route + capability tokens + rate limiting — tried, then removed as overkill) isn't
  worth it; core's fallback posts the saved file's path and the user opens it locally.
  Live-session-captured channels (#629) download images only for a sender who may steer
  (`canSteer` and not a member — Discord reuses `canTranscribe`, Teams mirrors it); core's
  `steerLive` stages them under `<tmpdir>/bean-live-images/<conv hash>/` and sends
  `[Image #N]: /abs/path` lines (N counts per session on the registry entry); history gets
  `[image attached]`, never a path. Discord replies naming any attachment the agent didn't get.
- **Ingest limits**: vision accepts only png/jpeg/webp (GIF excluded — animated GIFs are
  rejected by the API and detecting animation isn't worth it) — every surface filters on
  core's `SUPPORTED_IMAGE_MIMES` and caps at `MAX_IMAGES_PER_MESSAGE` (4) — the renderer
  keeps copies in `chat-types.ts` (it can't import core values). A bare `image/*` check lets
  HEIC/SVG through and fails the turn at the API.
- **Model comes from config.** `~/.bean/config.json` `imageModel`, default `gpt-image-2`,
  no Settings UI — `saveConfig` must keep preserving it (same pattern as `reasoningEffort`).
- **Slow-gen feedback**: the tool's `onStart` drives the desktop 🎨 working bubble
  (`IPC.chatImageProgress`) and the bots' "🎨 Working on your image…" post.
- **Teams attachment downloads need the bot's bearer token** — inline-image `contentUrl`s sit
  on the SMBA endpoint and 401 on a plain fetch; `server.ts`'s `downloadImages()` gets the
  token via `credentialsFactory.createCredentials(...).getToken()`.
- **Agent mode (#628): images are `[Image #N]` labels, never bytes.** The CLIs read an image from
  an absolute path in the prompt. A Finder drop maps the label to the file's own path; a paste or
  browser drag is written by core `stageImages()` (via `IPC.chatStageImage`, mount-checked) to a
  private per-run `os.tmpdir()/bean-images-*` dir (0700, files 0600). The label map lives in
  `ChatSession` (chat-scoped, never cleared, numbers never reused); only the text sent to the agent
  (`withImagePaths`: deliver / queued / liveStart `ask`) gets the `[Image #N]: /path` lines — the
  ChatItem, `typed` and the liveStart `label` stay label-only, so no path reaches `bean.db`. A
  Bean-bound send holding mapped labels is refused inline; Bean-mode image turns hand over as
  `[image attached — not handed over]`.
- **PDFs (#731, desktop Bean mode only) are pinned per chat, not per turn.** Drop/paste/avatar drop
  (`DroppedImage` carries PDFs too) → composer chip; `ChatSession`'s `pdfRef` holds the bytes and
  every Bean turn sends `documents` (core re-sends them as one framed message before history). Bytes
  never touch a `ChatItem`: the attaching user item has `pdf: { name, size }`, saved as
  `[PDF attached: name]`; a restored chat gets one "drop it again" row (`restoredPdf` dedupes). Main
  runs `checkPdfAttachment` before `converse()`; a thrown check or a `result.error` on a PDF turn
  unpins it so one bad file can't sink every later turn. Agent mode gets the PDF's path as text.
