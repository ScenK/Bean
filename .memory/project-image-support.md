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
  `BotEffects.sendFile` instead — Discord native upload, Teams inline base64 `contentUrl`).
- **Model comes from config.** `~/.bean/config.json` `imageModel`, default `gpt-image-2`,
  no Settings UI — `saveConfig` must keep preserving it (same pattern as `liveSessions`).
- **Slow-gen feedback**: the tool's `onStart` drives the desktop 🎨 working bubble
  (`IPC.chatImageProgress`) and the bots' "🎨 Working on your image…" post.
- **Teams attachment downloads need the bot's bearer token** — inline-image `contentUrl`s sit
  on the SMBA endpoint and 401 on a plain fetch; `server.ts`'s `downloadImages()` gets the
  token via `credentialsFactory.createCredentials(...).getToken()`.
