# Discord tables render at send time (grid or records)

Discord has no table syntax, so `packages/discord/src/tables.ts` `renderTables()` rewrites each GFM
table on the way out (`sendChunks`, `postHere`, slash replies): a code-block grid when
`Σ(Aᵢ + 2·Cᵢ) + 2·(n − 1) ≤ PHONE_COLS` (33, measured on the owner's iPhone — code blocks wrap,
they don't scroll), per-row records otherwise. Stored history and outbox bodies keep the original
markdown; only reply-to stitching sees the rendered text.

- Wide (CJK) cells pad with U+3000, not two spaces — only that aligned on the phone. Ambiguous-width
  chars count narrow. Emoji/uncertain clusters, links, mentions and backticks only in the last column.
- No cell containing ```` ``` ```` ever goes in a grid: Discord ends a code block at the first ```` ``` ````.
- `chunkText` is fence-aware (closes/reopens a split code block); keep it that way or a split grid
  inverts the next message.

- Live-session streams (#1085): `postStream`/`editStream` run `renderStream()` on each cumulative
  snapshot — raw text when the render would pass 2000 (core caps the raw snapshot at 1900). Core's
  rollover (`rolloverCut` in `chatops/live-sessions.ts`) cuts before a `|`-led block with a
  delimiter row instead of inside it, unless the table starts the message.

Epic #1083.
