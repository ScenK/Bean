# Models are config, providers are code

`clis.json` (repo `.bean/` default, `~/.bean` per-provider override via `loadCliModels`)
defines which models each CLI offers. The model string is the literal `--model` value —
there is no canonical-id/alias layer anymore (`MODELS`/`resolveModelAlias` are gone; don't
reintroduce them). Adding a new model = edit clis.json, no build. Adding a new CLI =
code (argv shape in launcher/delegate + parser) **and** a `KNOWN_PROVIDERS` entry in
`cli-models.ts`. Old model-memory entries with pre-migration canonical ids (`gpt-5-5`)
simply fail `pickModel`'s support check and fall back — harmless, self-healing on next pick.
