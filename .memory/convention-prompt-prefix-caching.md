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
hint (all converse calls share the same prefix start). Regression guard: the
"leading system message is byte-stable across turns" test in `packages/core/__test__/converse.test.ts`.
