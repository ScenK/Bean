# convention — keep converse()'s leading system message byte-stable (prompt caching)

OpenAI prompt caching is exact-prefix: the cached prefix is `[system, history…]` plus the
tools array, and any byte that changes invalidates everything after it. `converse()` therefore
splits its prompt in two:

- **Leading system message** — persona + behavior instructions + skills/projects catalog +
  linked note. Everything here must be deterministic for the life of a chat. **Never add
  per-turn content** (clocks, per-message memory ranking, random ids) to this message or to
  the tool specs — doing so re-bills the whole conversation uncached on every turn.
- **Trailing context system message** — inserted between history and the latest user message.
  This is where volatile, per-turn context lives today: `Current date and time` and the
  `What you remember:` block (whose selection depends on `latestUserText`). New volatile
  context belongs here.

`makeOpenAIConverseWithClient` also sends `prompt_cache_key: "bean-converse"` as a cache-routing
hint (all callers of the adapter — converse and routine chat steps — share it; fine at Bean's
volume). Regression guard: the "leading system message is byte-stable across turns" test in
`packages/core/__test__/converse.test.ts`.

Evaluated and deliberately left alone:

- **Routine chat steps** (`routine-runner.ts` `runChatStep`) already order their one system
  message stable-first (role line, skill body) with the volatile parts (prior step outputs,
  clock) last, so the stable prefix caches across cron runs; only the short static instruction
  after the clock re-bills. Not worth reordering.
- **Chatops compaction** (`chatops/compact.ts`) rewrites the history head (oldest 40 → 1
  summary) and necessarily busts the whole prefix — but only once per ~40 turns, and the
  alternative (unbounded history) costs more than the periodic bust. Inherent tradeoff.
- **Ambient channel blocks** (`chatops/bot.ts`) are persisted into history as ordinary turns,
  so their time anchors freeze and the prefix stays append-only — keep it that way; injecting
  them per-request instead would churn the prefix.
