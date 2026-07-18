# Config-driven CLI models

**Date:** 2026-07-17
**Status:** Approved

## Problem

Model names are hardcoded in `packages/core/src/models.ts` (`MODELS` constant). Every new
model release (new Sonnet, new Copilot model) requires a code change and a new Bean build.
The `ModelInfo`/alias machinery (canonical id → per-CLI flag spelling) exists only because
models were once shared across CLIs; today each model belongs to exactly one CLI, so the
indirection carries no weight.

## Decision

Providers (CLIs) stay in code — `opencode` and `claude`, with their argv shapes and output
parsers unchanged. Which **models** each provider offers moves to config. The model string
in config is passed verbatim as the `--model` value; there is no canonical id or alias layer.

Adding a genuinely new CLI still requires code (argv shape + parser are behavior, not data).
Accepted trade-off.

## Config file

`clis.json` — an array of provider entries:

```json
[
  { "provider": "claude", "models": ["haiku", "sonnet", "opus"] },
  { "provider": "opencode", "models": ["github-copilot/gpt-5.5", "github-copilot/claude-sonnet-5"] }
]
```

- **Repo default:** `.bean/clis.json` (same repo-shipped-defaults pattern as skills/persona,
  resolved via `projectBeanDir()`).
- **User override:** `~/.bean/clis.json`. Merge is **per provider**: a user entry for
  `claude` replaces the default `claude` model list entirely; providers absent from the
  user file keep their defaults.
- **Degrade rules** (match existing loaders): missing user file → defaults only. Invalid
  JSON or wrong shape in user file → log to console, use defaults. Entry whose `provider`
  is not a known `CliName` → skipped with a log line. Provider entry with empty/missing
  `models` array → that provider offers no models (its picker rows disappear).
  Missing/invalid **repo default** file → empty list (same "degrade to []" rule as
  skills/projects); Bean still runs, model pickers are empty, launches omit `--model`.

## Core changes (`@bean/core`)

### `models.ts` — shrinks

- **Delete:** `ModelInfo.aliases`, `MODELS`, `resolveModelAlias`.
- Model identity = the literal flag string (`"sonnet"`, `"github-copilot/gpt-5.5"`).
- New shape flowing through the system:

  ```ts
  export interface CliModels { provider: CliName; models: string[]; }
  export type AvailableModel = { id: string; label: string; availableOn: CliName[] };
  ```

- `availableModels(cliModels: CliModels[], detected: CliName[]): AvailableModel[]` —
  flattens config entries for detected CLIs. `label` = the string's last `/` segment
  (`github-copilot/gpt-5.5` → `gpt-5.5`), full string otherwise. `availableOn` = the one
  provider that lists it (kept as an array so the picker's dimmed/reason rows work
  unchanged; a model listed under two providers gets both).
- `pickModel(models, cli, choice?, lastUsed?)` — same contract as today: explicit choice →
  remembered → first model the current CLI supports; never returns a model the CLI can't run.

### New loader — `cli-models.ts`

```ts
export async function loadCliModels(defaultFile: string, userFile: string): Promise<CliModels[]>
```

Pure, takes explicit paths, applies the merge + degrade rules above. Path helper
`clisFile(dir)` added to `config.ts`. Exported from `index.ts`.

### `launcher.ts` / `delegate.ts`

`launchCommand` and `delegateCommand` drop the `resolveModelAlias` lookup and pass
`req.model` straight to `--model` (flag still omitted when `req.model` is undefined).
Argv shapes, script writing, spawn behavior, parsers: unchanged.

### Callers of `availableModels` (chatops `resolve.ts`, bot deps)

`resolveCliModel` gains the loaded `CliModels[]` as an input (threaded through existing
DI — `buildTeamsBot` deps get a `cliModels` field alongside `detectClis`).

## Wiring (`@bean/app`, `@bean/discord`, `@bean/teams`)

- Each surface loads `loadCliModels(clisFile(builtinDir), clisFile(dir))` at boot, next to
  `loadConfig`, and passes the result through existing DI.
- **Renderer:** components (`ChatWindow`, `PlanWindow`, `RoutinesPanel`) currently import
  `MODELS`/`availableModels` statically from core. The data is now runtime, so one new IPC
  getter (`bean:cli-models` → preload `window.bean.cliModels()`) returns the loaded
  `CliModels[]`; renderer calls `availableModels` on it client-side. `bean.d.ts` updated.
- Model memory (`model-memory.json`) unchanged — it already stores strings; a remembered
  model no longer present in config simply fails `pickModel`'s support check and falls back.

## Not doing (YAGNI)

- New CLIs via config (argv templates, parser names) — revisit if a third CLI lands.
- Display labels in config — derived from the string.
- Per-model metadata (context size, cost) — no consumer.
- Live reload of `clis.json` — loaded at boot like everything else.

## Testing

- `cli-models.test.ts`: merge per provider, user-wins, unknown provider skipped, invalid
  user file → defaults, missing default file → `[]`.
- `models.test.ts`: rewrite for new `availableModels`/`pickModel` inputs; label derivation.
- `launcher.test.ts` / `delegate.test.ts`: `--model` passes the raw string; omitted when unset.
- Existing chatops `resolve` tests re-pointed at the new input shape.
- Validation gate: `pnpm test && pnpm typecheck`.
