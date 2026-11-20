# project — desktop chat rolling summary (#975)

Desktop chats used to send the whole transcript as model history every turn, bounded only by the
save trim (500 items / 2 MB) — once a chat hit the cap its first history message changed every turn,
so the prompt prefix cache missed every turn. Now:

- **Where it runs:** the host's `chat` handler (`buildChatHandler`) calls core `compactHistory`
  (`chatops/compact.ts`, next to chatops' `summarizeTurns`) before `converse()`. It runs on the core,
  so a remote shell compacts too (it never holds the API key) — no new IPC channel; `ChatRequest`
  gained `summary`, `ConverseResult` gained `summary: { text, covers }` (both wire guards:
  `channel-contract.ts` and `remote.ts`).
- **Budget:** counted on the model's turns (`chatTurns` output), not raw items: > 60 turns or
  > 200 KB → everything but the last 20 turns (and at most half the byte budget) folds, together with
  the previous summary, into one new summary. Under budget, history is `summary block + turns` as-is,
  so the prefix is byte-identical between compaction events. Each turn's summary input is capped
  (`SUMMARY_TURN_CHARS`), the summary itself at `SUMMARY_MAX_CHARS`.
- **Failure:** a failed/empty/stopped summary call keeps the previous summary and sends only the tail;
  the turn still answers and the next turn retries.
- **Renderer:** a hidden `summary` ChatItem placed right after the last item it covers
  (`placeSummary`, mapped by the per-turn `owners` from `modelHistory`). History = the **latest**
  summary + the items after it, **by position** (ids are remapped on restore). ChatSession filters it
  out before ChatPanel, so rendering, Find and agent-run avatars never see it.
- **Save:** `normalizeForSave` keeps only the latest summary and never trims it away (cut past, it
  stays first). Off-the-record chats never save, so their summary lives in memory only.
- **Memory:** `closeTranscript` reads only the items after the latest summary; a summary is never
  episode evidence (`chatTurns` maps it to nothing).
