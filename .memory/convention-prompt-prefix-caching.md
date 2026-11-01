# convention — keep converse()'s leading system message byte-stable (prompt caching)

OpenAI prompt caching is exact-prefix: the cached prefix is `[system, history…]` plus the
tools array, and any byte that changes invalidates everything after it. `converse()`'s order:
leading system → linked-note user message → history → recall user message → trailing system →
latest user.

- **Leading system message** — persona + behavior instructions + skills/projects catalog + a
  fixed linked-note pointer (no title/body). Everything here must be deterministic for the life
  of a chat. **Never add per-turn content** (clocks, per-message memory ranking, random ids) to
  this message or to the tool specs (`propose_note`'s linked description is title-free for this
  reason) — doing so re-bills the whole conversation uncached on every turn.
- **Linked note** — its own framed user message right after the leading system message, so a
  save-in-place re-bills only what follows it (saved text never rides in system — see
  [safety-saved-text-never-system](safety-saved-text-never-system.md)).
- **Recall** (`What you remember`, selection depends on `latestUserText`) — its own user
  message after history, before the trailing system message.
- **Trailing context system message** — just before the latest user message: `Current date and
  time` and the chatops `roleNote`. New volatile *code-built* context belongs here.

`makeOpenAIConverseWithClient` also sends `prompt_cache_key: "bean-converse"` as a cache-routing
hint (all callers of the adapter — converse and routine chat steps — share it; fine at Bean's
volume). Regression guard: the "leading system message is byte-stable across turns" test in
`packages/core/__test__/converse.test.ts`.

Evaluated and deliberately left alone:

- **Routine chat steps** (`routine-runner.ts` `runChatStep`): one system message (role line,
  skill body, clock last), then recall and prior outputs as user messages, then the instruction.
- **Chatops compaction** (`chatops/compact.ts`) rewrites the history head (oldest 40 → 1
  summary) and necessarily busts the whole prefix — but only once per ~40 turns, and the
  alternative (unbounded history) costs more than the periodic bust. Inherent tradeoff.
- **Ambient channel blocks** (`chatops/bot.ts`) are persisted into history as ordinary turns,
  so their time anchors freeze and the prefix stays append-only — keep it that way; injecting
  them per-request instead would churn the prefix.
