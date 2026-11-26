# Models are config, providers are code

`clis.json` (repo `.bean/` default, `~/.bean` per-provider override via `loadCliModels`)
defines which models each CLI offers. The model string is the literal `--model` value —
there is no canonical-id/alias layer anymore (`MODELS`/`resolveModelAlias` are gone; don't
reintroduce them). Adding a new model = edit clis.json, no build, no restart: `watchCliModels` stat-polls
`~/.bean/clis.json` and refills the *same* array in place (host + both bots), so hold the
array, never copy it; pickers refetch on window focus. The repo default is ours to maintain:
latest version per tier only (sol/astra/terra/luna, opus/sonnet…), superseded ones dropped —
except when the latest regressed (e.g. gpt-6.2-sol): keep the previous one beside it until
the new one is trusted, since sprouts pin it.
agy is paid-tier only (agy users are on Google AI Pro or above): the latest Gemini paid tiers
(today `gemini-4-neon`, `gemini-4-carbon`), configured with `efforts`, `defaultEffort`, and
`effortIds` mapping each effort to agy's literal suffixed model ID (`gemini-4-neon-high`, etc.).
Legacy sprouts/receipts naming a suffixed ID stay accepted via `cliOffersModel` and `resolveWireModel`.
Never add free-tier models (Flash, Hydrogen) or the third-party models agy also serves (Claude,
GPT-OSS). A free account's `agy models` lists none of the paid tiers, so read the IDs from
antigravity.google/docs/models instead.
Per-model reasoning effort is declared in `clis.json` (`{ id, efforts, defaultEffort?, effortIds? }`)
alongside plain string entries; provider code maps `effort` to each CLI's native flag (`claude`
`--effort`, `codex` `-c model_reasoning_effort="…"`, `opencode` `--variant`, `agy` `effortIds` or `--effort`).
Users keep an older one with `add` — prefer `add`/`hide` over `models`, which freezes the
provider's list against future defaults. Dropping a model fails any sprout step pinned to it
(`pinnedStepSelection`), so call drops out in release notes. Tests seed their own
`~/.bean/clis.json` and never assert a repo-default model: that list changes every release. Adding a new CLI =
code (argv shape in launcher/delegate + parser) **and** a `KNOWN_PROVIDERS` entry in
`cli-models.ts`. Old model-memory entries with pre-migration canonical ids (`gpt-5-5`)
simply fail `pickModel`'s support check and fall back — harmless, self-healing on next pick.
