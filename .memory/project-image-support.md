# Image support (recognition + generation)

Spec: `docs/superpowers/specs/2026-07-26-image-support-design.md`.

- **Recognition is latest-turn-only.** `ConverseInput.latestUserImages` attaches images to
  the current user turn; `ChatTurn`/history stays text with a `[image attached]` placeholder
  (all surfaces do this). Deliberate ceiling: multi-turn follow-ups about the same image lose
  the pixels — widen `ChatTurn` only if that ever matters. Never store base64 in bean.db.
- **Generation is a per-request tool.** `makeGenerateImageTool()` (core `image-gen.ts`) must
  be built fresh per converse() call — its `paths` array collects that one turn's generated
  files (a shared instance leaks paths across requests). `converse()` never sets
  `ConverseResult.generatedImages`; surface handlers do (desktop fills `dataUrl`; bots use
  `BotEffects.sendFile` instead — Discord native upload; Teams serves the PNG from its own
  express server and links it via `teams.json`'s `publicBaseUrl` because Teams rejects large
  inline base64 activities — no `publicBaseUrl` = no `sendFile` (route not even mounted),
  core posts the path). The Teams route serves ONLY opaque expiring per-send tokens
  (`publishImage()`), never filenames — `~/.bean/images` holds every surface's history and
  must not be enumerable. Live-session-captured channels skip attachment downloads entirely
  (bridged agent takes text only).
- **Ingest MIME allowlist**: vision accepts only png/jpeg/gif/webp — every surface filters on
  core's `SUPPORTED_IMAGE_MIMES` (renderer keeps a copy in `chat-types.ts`; it can't import
  core values). A bare `image/*` check lets HEIC/SVG through and fails the turn at the API.
- **Model comes from config.** `~/.bean/config.json` `imageModel`, default `gpt-image-2`,
  no Settings UI — `saveConfig` must keep preserving it (same pattern as `liveSessions`).
- **Slow-gen feedback**: the tool's `onStart` drives the desktop 🎨 working bubble
  (`IPC.chatImageProgress`) and the bots' "🎨 Working on your image…" post.
- **Teams attachment downloads need the bot's bearer token** — inline-image `contentUrl`s sit
  on the SMBA endpoint and 401 on a plain fetch; `server.ts`'s `downloadImages()` gets the
  token via `credentialsFactory.createCredentials(...).getToken()`.
