# Config-Driven CLI Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the hardcoded model list out of `@bean/core` into a layered `clis.json` config (repo default + `~/.bean` override); model strings pass verbatim to `--model`.

**Architecture:** Providers (`opencode`, `claude`) stay in code. A new pure loader `loadCliModels(defaultFile, userFile)` returns `CliModels[]`; `models.ts` loses `MODELS`/`resolveModelAlias`/aliases and derives `AvailableModel` from that data; every consumer gets the data threaded through existing DI (bot deps, IPC handler deps, server boot).

**Tech Stack:** TypeScript ESM (`.js` import extensions, `import type`), vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-17-config-driven-cli-models-design.md`

## Global Constraints

- Both packages ESM, `verbatimModuleSyntax` on: relative imports need `.js` extension, type-only imports use `import type`.
- `strict` + `noUncheckedIndexedAccess`: array indexing yields `T | undefined` — handle it.
- Core stays Electron-free and dependency-injected (loaders take explicit paths).
- Validation gate per task: `pnpm --filter @bean/core test` (or the touched package); final task runs `pnpm test && pnpm typecheck` at root.
- Commit after each task.
- Run all commands from the worktree root: `/Users/scenkang/Develop/Bean/.claude/worktrees/session-674e42`.

---

### Task 1: `loadCliModels` loader + repo default `clis.json`

**Files:**
- Create: `packages/core/src/cli-models.ts`
- Create: `.bean/clis.json` (repo root — sibling of `.bean/skills/`; ships in the packaged app because `extraResources` already copies all of `../../.bean` to `resources/builtin`)
- Modify: `packages/core/src/config.ts` (add `clisFile` helper next to the other path helpers)
- Modify: `packages/core/src/index.ts` (add export line)
- Test: `packages/core/__test__/cli-models.test.ts`

**Interfaces:**
- Consumes: `CliName` from `./launcher.js` (existing: `"opencode" | "claude"`).
- Produces: `interface CliModels { provider: CliName; models: string[] }` and `loadCliModels(defaultFile: string, userFile: string): Promise<CliModels[]>` — Task 2's `availableModels` and Task 3/4 boot wiring consume these. Also `clisFile(dir: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/cli-models.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadCliModels } from "../src/cli-models.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bean-clis-"));
}

const DEFAULTS = JSON.stringify([
  { provider: "claude", models: ["sonnet", "opus"] },
  { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
]);

test("loads defaults when the user file is missing", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  const result = await loadCliModels(join(d, "default.json"), join(d, "nope.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["sonnet", "opus"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ]);
});

test("a user entry replaces that provider's default list entirely", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  await writeFile(join(d, "user.json"), JSON.stringify([{ provider: "claude", models: ["haiku"] }]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["haiku"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ]);
});

test("invalid JSON in the user file degrades to defaults", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  await writeFile(join(d, "user.json"), "{not json");
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toHaveLength(2);
});

test("unknown providers are skipped, non-string models filtered", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), JSON.stringify([
    { provider: "codex", models: ["gpt-5"] },
    { provider: "claude", models: ["sonnet", 42, ""] },
  ]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "nope.json"));
  expect(result).toEqual([{ provider: "claude", models: ["sonnet"] }]);
});

test("missing default file yields an empty list", async () => {
  const d = await dir();
  expect(await loadCliModels(join(d, "nope.json"), join(d, "also-nope.json"))).toEqual([]);
});

test("a user file can add a provider absent from defaults", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), JSON.stringify([{ provider: "claude", models: ["sonnet"] }]));
  await writeFile(join(d, "user.json"), JSON.stringify([{ provider: "opencode", models: ["github-copilot/gpt-5.5"] }]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["sonnet"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/cli-models.test.ts`
Expected: FAIL — `Cannot find module '../src/cli-models.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/cli-models.ts`:

```typescript
import { readFile } from "node:fs/promises";
import type { CliName } from "./launcher.js";

/** Which models each provider (CLI) offers — loaded from clis.json, not hardcoded.
 * A model string is passed verbatim as the CLI's --model value; there is no canonical
 * id or alias layer (see the 2026-07-17 config-driven-cli-models spec). */
export interface CliModels {
  provider: CliName;
  models: string[];
}

const KNOWN_PROVIDERS: readonly CliName[] = ["opencode", "claude"];

// Degrades per entry, never throws: a bad file yields undefined (caller falls back),
// a bad entry is skipped with a log line — same spirit as the skills/projects loaders.
function parseCliModels(raw: string, source: string): CliModels[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`bean: ${source} is not valid JSON — ignoring it`);
    return undefined;
  }
  if (!Array.isArray(data)) {
    console.error(`bean: ${source} is not an array — ignoring it`);
    return undefined;
  }
  const out: CliModels[] = [];
  for (const entry of data) {
    const e = entry as { provider?: unknown; models?: unknown } | null;
    const provider = e?.provider;
    if (typeof provider !== "string" || !KNOWN_PROVIDERS.includes(provider as CliName)) {
      console.error(`bean: ${source}: unknown provider ${JSON.stringify(provider)} — skipped (adding a new CLI needs code)`);
      continue;
    }
    const models = Array.isArray(e?.models)
      ? e.models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    out.push({ provider: provider as CliName, models });
  }
  return out;
}

/** Repo defaults overlaid by the user file, merged per provider: a user entry for a
 * provider replaces that provider's default model list entirely; providers absent from
 * the user file keep their defaults. Missing/invalid user file → defaults only;
 * missing/invalid default file → []. */
export async function loadCliModels(defaultFile: string, userFile: string): Promise<CliModels[]> {
  const read = async (file: string): Promise<CliModels[] | undefined> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    return parseCliModels(raw, file);
  };
  const merged = [...((await read(defaultFile)) ?? [])];
  for (const entry of (await read(userFile)) ?? []) {
    const i = merged.findIndex((d) => d.provider === entry.provider);
    if (i === -1) merged.push(entry);
    else merged[i] = entry;
  }
  return merged;
}
```

In `packages/core/src/config.ts`, add after the `configFile` helper (line 20):

```typescript
export function clisFile(dir: string): string { return join(dir, "clis.json"); }
```

In `packages/core/src/index.ts`, add next to `export * from "./models.js";`:

```typescript
export * from "./cli-models.js";
```

Create `.bean/clis.json` at the repo root (current `MODELS` contents, verbatim flag strings):

```json
[
  { "provider": "claude", "models": ["sonnet", "opus", "haiku"] },
  {
    "provider": "opencode",
    "models": [
      "github-copilot/gpt-5.5",
      "github-copilot/gpt-5.4",
      "github-copilot/claude-sonnet-5",
      "github-copilot/claude-opus-4.8"
    ]
  }
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/cli-models.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-models.ts packages/core/src/config.ts packages/core/src/index.ts .bean/clis.json packages/core/__test__/cli-models.test.ts
git commit -m "feat(core): add loadCliModels loader and repo-default clis.json"
```

---

### Task 2: Rewire core — models.ts, launcher, delegate, converse, chatops

One task because deleting `MODELS`/`resolveModelAlias` breaks every core consumer at once; splitting would leave non-compiling intermediate commits.

**Files:**
- Modify: `packages/core/src/models.ts` (full rewrite below)
- Modify: `packages/core/src/launcher.ts:8,59,62-87`
- Modify: `packages/core/src/delegate.ts:4,10,30-46`
- Modify: `packages/core/src/converse.ts:7,218-247,275-296,405-421`
- Modify: `packages/core/src/chatops/resolve.ts`
- Modify: `packages/core/src/chatops/bot.ts:5,64,384-393,476-489,541-551`
- Test: `packages/core/__test__/models.test.ts` (rewrite), `launcher.test.ts`, `delegate.test.ts`, `chatops-resolve.test.ts`, `converse.test.ts:455-495`, `chatops-bot.test.ts` (deps fixture)

**Interfaces:**
- Consumes: `CliModels` from Task 1.
- Produces (Tasks 3–4 rely on these exact shapes):
  - `type AvailableModel = { id: string; label: string; availableOn: CliName[] }` (no more `aliases`)
  - `availableModels(cliModels: CliModels[], detected: CliName[]): AvailableModel[]`
  - `pickModel(models: AvailableModel[], cli: CliName, choice?: string, lastUsed?: string): string | undefined` (unchanged signature)
  - `ConverseInput` gains optional `models?: AvailableModel[]`
  - `resolveCliModel(detected: CliName[], stated: { cli?: CliName; model?: string }, memory: Record<string, string>, cliModels: CliModels[]): CliModelChoice | undefined`
  - `BotDeps` (in `bot.ts`) gains required `cliModels: CliModels[]`
  - Deleted: `MODELS`, `ModelInfo`, `resolveModelAlias`

- [ ] **Step 1: Rewrite the models tests to the new API**

Replace `packages/core/__test__/models.test.ts` entirely:

```typescript
import { expect, test } from "vitest";
import { availableModels, pickModel } from "../src/models.js";
import type { CliModels } from "../src/cli-models.js";

const CLI_MODELS: CliModels[] = [
  { provider: "claude", models: ["sonnet", "opus", "haiku"] },
  { provider: "opencode", models: ["github-copilot/gpt-5.5", "github-copilot/claude-sonnet-5"] },
];

test("availableModels lists every configured model, marking undetected providers unavailable", () => {
  const result = availableModels(CLI_MODELS, ["claude"]);
  expect(result).toHaveLength(5);
  expect(result.find((m) => m.id === "sonnet")?.availableOn).toEqual(["claude"]);
  expect(result.find((m) => m.id === "github-copilot/gpt-5.5")?.availableOn).toEqual([]);
});

test("availableModels derives the label from the last path segment", () => {
  const result = availableModels(CLI_MODELS, ["claude", "opencode"]);
  expect(result.find((m) => m.id === "github-copilot/gpt-5.5")?.label).toBe("gpt-5.5");
  expect(result.find((m) => m.id === "sonnet")?.label).toBe("sonnet");
});

test("availableModels with no detected CLIs marks every model unavailable", () => {
  expect(availableModels(CLI_MODELS, []).every((m) => m.availableOn.length === 0)).toBe(true);
});

test("a model listed under both providers gets both in availableOn", () => {
  const shared: CliModels[] = [
    { provider: "claude", models: ["sonnet"] },
    { provider: "opencode", models: ["sonnet"] },
  ];
  const result = availableModels(shared, ["claude", "opencode"]);
  expect(result).toHaveLength(1);
  expect(result[0]?.availableOn).toEqual(["claude", "opencode"]);
});

test("pickModel keeps an explicit pick the current CLI supports", () => {
  const models = availableModels(CLI_MODELS, ["opencode", "claude"]);
  expect(pickModel(models, "opencode", "github-copilot/claude-sonnet-5")).toBe("github-copilot/claude-sonnet-5");
});

test("pickModel drops a pick unsupported by the current CLI and falls back to a supported one", () => {
  const models = availableModels(CLI_MODELS, ["opencode", "claude"]);
  expect(pickModel(models, "claude", "github-copilot/claude-sonnet-5")).toBe("sonnet");
});

test("pickModel ignores a last-used model the current CLI can't run", () => {
  const models = availableModels(CLI_MODELS, ["claude"]);
  expect(pickModel(models, "claude", undefined, "github-copilot/claude-sonnet-5")).toBe("sonnet");
});

test("pickModel prefers a supported last-used model when there's no explicit pick", () => {
  const models = availableModels(CLI_MODELS, ["opencode", "claude"]);
  expect(pickModel(models, "opencode", undefined, "github-copilot/claude-sonnet-5")).toBe("github-copilot/claude-sonnet-5");
});

test("pickModel with an empty models list returns undefined", () => {
  expect(pickModel([], "claude")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/models.test.ts`
Expected: FAIL — `availableModels` called with wrong arity / `CliModels` import errors.

- [ ] **Step 3: Rewrite `packages/core/src/models.ts`**

Replace the whole file:

```typescript
import type { CliName } from "./launcher.js";
import type { CliModels } from "./cli-models.js";

/** A model id is the literal --model flag string from clis.json (e.g. "sonnet",
 * "github-copilot/gpt-5.5") — launchCommand/delegateCommand pass it verbatim. `label` is
 * derived (last `/` segment); `availableOn` lists the detected CLIs whose config offers it
 * (empty = shown dimmed in the picker). */
export type AvailableModel = { id: string; label: string; availableOn: CliName[] };

function modelLabel(id: string): string {
  const seg = id.split("/").pop();
  return seg !== undefined && seg.trim() !== "" ? seg : id;
}

/** Every configured model annotated with which of the detected CLIs offers it — drives
 * the model picker's dimmed/reason-captioned rows. Undetected providers' models are kept
 * (dimmed) so the picker shows what would be available if that CLI were installed. */
export function availableModels(cliModels: CliModels[], detected: CliName[]): AvailableModel[] {
  const out: AvailableModel[] = [];
  for (const entry of cliModels) {
    for (const id of entry.models) {
      const offered = detected.includes(entry.provider);
      const existing = out.find((m) => m.id === id);
      if (existing) {
        if (offered && !existing.availableOn.includes(entry.provider)) existing.availableOn.push(entry.provider);
      } else {
        out.push({ id, label: modelLabel(id), availableOn: offered ? [entry.provider] : [] });
      }
    }
  }
  return out;
}

/** The model the proposal will actually launch with, given an explicit user pick, the
 * last-used model, and the current CLI. Keeps the picked/remembered model only while the
 * current CLI supports it — otherwise falls back to a CLI-supported model, so switching CLI
 * can never launch a model the CLI silently ignores (would run its default). */
export function pickModel(
  models: AvailableModel[],
  cli: CliName,
  choice?: string,
  lastUsed?: string,
): string | undefined {
  const supportsCli = (id: string | undefined): boolean =>
    id !== undefined && models.some((m) => m.id === id && m.availableOn.includes(cli));
  const remembered = lastUsed !== undefined && models.some((m) => m.id === lastUsed) ? lastUsed : undefined;
  const preferred = choice ?? remembered;
  if (supportsCli(preferred)) return preferred;
  return models.find((m) => m.availableOn.includes(cli))?.id ?? models[0]?.id;
}
```

- [ ] **Step 4: Drop the alias lookup in `launcher.ts` and `delegate.ts`**

`packages/core/src/launcher.ts`:
- Delete line 8: `import { resolveModelAlias } from "./models.js";`
- Line 59 comment becomes: `model?: string; // literal --model value (clis.json); ignored for "open"`
- Replace the `"opencode"` and `"claude"` cases of `launchCommand`:

```typescript
    case "opencode": {
      // --prompt=… as one token: a prompt starting with "-" (e.g. leftover frontmatter "---")
      // would otherwise be eaten by opencode's flag parser, launching the TUI with no prompt.
      return {
        command: "opencode",
        args: [req.projectPath, `--prompt=${req.prompt ?? ""}`, ...(req.model ? ["--model", req.model] : [])],
      };
    }
    case "claude":
      return { command: "claude", args: [...(req.model ? ["--model", req.model] : []), req.prompt ?? ""] };
```

`packages/core/src/delegate.ts`:
- Delete line 4: `import { resolveModelAlias } from "./models.js";`
- Line 10 comment becomes: `model?: string; // literal --model value (clis.json); flag omitted when unset`
- In `delegateCommand`, replace `const alias = req.model ? resolveModelAlias(req.model, req.cli) : undefined;` with `const modelArgs = req.model ? ["--model", req.model] : [];` and replace both `...(alias ? ["--model", alias] : [])` spreads with `...modelArgs`.

- [ ] **Step 5: Thread `models` through `converse.ts`**

- Line 7: replace `import { MODELS } from "./models.js";` with `import type { AvailableModel } from "./models.js";`
- Line 218: `function proposeDelegateTool(skills: Skill[], projects: Project[], availableClis: CliName[], models: AvailableModel[]): ToolSpec {`
- Line 239: replace with `const modelIds = models.filter((m) => m.availableOn.length > 0).map((m) => m.id);`
- In `ConverseInput` (line 275 block): add `models?: AvailableModel[]; // configured models (clis.json) for the propose_delegate enum; [] = no model param offered`
- In `converse()`'s destructuring (near line 309, next to `availableClis = []`): add `models = [],`
- Line 356: `proposeDelegateTool(skills, projects, availableClis, models)`
- Line 419: replace with `model: models.some((m) => m.id === args.model) ? (args.model as string) : undefined,`

- [ ] **Step 6: Thread `cliModels` through chatops**

`packages/core/src/chatops/resolve.ts` — new signature and body:

```typescript
import { availableModels, pickModel } from "../models.js";
import type { CliModels } from "../cli-models.js";
import type { CliName } from "../launcher.js";

export interface CliModelChoice {
  cli: CliName;
  model?: string;
}

const CLI_KEY = "teams:cli";
const modelKey = (cli: CliName): string => `teams:model:${cli}`;

/** Spec's three-layer resolution: chat-stated → last-used (model memory) → first detected.
 * pickModel guards the cli/model cross-product (a model the cli can't run falls back). */
export function resolveCliModel(
  detected: CliName[],
  stated: { cli?: CliName; model?: string },
  memory: Record<string, string>,
  cliModels: CliModels[],
): CliModelChoice | undefined {
  const remembered = memory[CLI_KEY] as CliName | undefined;
  const cli =
    stated.cli && detected.includes(stated.cli) ? stated.cli
    : remembered && detected.includes(remembered) ? remembered
    : detected[0];
  if (cli === undefined) return undefined;
  const model = pickModel(availableModels(cliModels, detected), cli, stated.model, memory[modelKey(cli)]);
  return { cli, model };
}

/** The model-memory entries a confirmed run should persist. */
export function memoryUpdatesFor(choice: CliModelChoice): Record<string, string> {
  return { [CLI_KEY]: choice.cli, ...(choice.model ? { [modelKey(choice.cli)]: choice.model } : {}) };
}
```

`packages/core/src/chatops/bot.ts`:
- Add `import type { CliModels } from "../cli-models.js";` next to the other type imports.
- In the bot deps interface (around line 64, next to `detectClis: () => CliName[];`): add
  `cliModels: CliModels[]; // loaded once at boot from clis.json (repo default + ~/.bean override)`
- In `converseBase` (line 384 block): add `models: availableModels(deps.cliModels, detected),`
- Line 476 and the ~line 543 call: add `deps.cliModels` as the fourth argument to `resolveCliModel(...)`.
- Line 489: `models: availableModels(deps.cliModels, detected),`

- [ ] **Step 7: Fix the remaining core tests**

`packages/core/__test__/launcher.test.ts` (lines 21–33): model values are now verbatim strings —

```typescript
test("launchCommand appends --model with the verbatim model string for opencode", () => {
  const req: LaunchRequest = { mode: "opencode", projectPath: "/p", prompt: "go", model: "github-copilot/claude-sonnet-5" };
  expect(launchCommand(req).args).toEqual(["/p", "--prompt=go", "--model", "github-copilot/claude-sonnet-5"]);
});

test("launchCommand appends --model with the verbatim model string for claude", () => {
  const req: LaunchRequest = { mode: "claude", projectPath: "/p", prompt: "go", model: "sonnet" };
  expect(launchCommand(req).args).toEqual(["--model", "sonnet", "go"]);
});

test("launchCommand omits --model when no model was picked", () => {
  const req: LaunchRequest = { mode: "claude", projectPath: "/p", prompt: "go" };
  expect(launchCommand(req).args).toEqual(["go"]);
});
```

`packages/core/__test__/delegate.test.ts` (lines 59–66): same change —

```typescript
  it("appends --model with the verbatim model string", () => {
    const { args } = delegateCommand({ cli: "opencode", projectPath: "/p", prompt: "fix", model: "github-copilot/claude-sonnet-5" });
    expect(args).toEqual(["run", "--auto", "--model", "github-copilot/claude-sonnet-5", "fix" + GIT_TRAILER_INSTRUCTION]);
  });

  it("omits --model when no model was picked", () => {
    const { args } = delegateCommand({ cli: "claude", projectPath: "/p", prompt: "fix" });
    expect(args).not.toContain("--model");
  });
```

`packages/core/__test__/chatops-resolve.test.ts`: add at the top —

```typescript
import type { CliModels } from "../src/cli-models.js";

const CLI_MODELS: CliModels[] = [
  { provider: "claude", models: ["sonnet", "opus", "haiku"] },
  { provider: "opencode", models: ["github-copilot/gpt-5.5", "github-copilot/claude-sonnet-5"] },
];
```

and pass `CLI_MODELS` as the fourth argument to every `resolveCliModel(...)` call. Replace old
opencode-only ids in assertions: `"gpt-5-5"` → `"github-copilot/gpt-5.5"` (the "stated cli+model
win" and "unsupported falls back" tests keep the same shape, expecting `"sonnet"` fallback).

`packages/core/__test__/converse.test.ts` (lines ~455–495): the delegate-proposal tests must now
pass a `models` input. Where the test builds the `converse({ ... availableClis: [...] })` input,
add:

```typescript
      models: availableModels(
        [
          { provider: "claude", models: ["sonnet", "opus", "haiku"] },
          { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
        ],
        /* same clis as the test's availableClis */ ["opencode"],
      ),
```

(import `availableModels` from `../src/models.js`), replace `"gpt-5-5"` with
`"github-copilot/gpt-5.5"` in args/assertions, and keep the line-491/492 assertions:
`enum` contains `"sonnet"`, does not contain `"github-copilot/gpt-5.5"` when only claude
is detected (pass `["claude"]` as detected there).

`packages/core/__test__/chatops-bot.test.ts`: wherever the test builds the bot deps object
(the fixture that already has `detectClis: () => [...]`), add:

```typescript
  cliModels: [
    { provider: "claude", models: ["sonnet", "opus", "haiku"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ],
```

and update any model-id assertions from old canonical ids to verbatim strings.

- [ ] **Step 8: Run the core suite**

Run: `pnpm --filter @bean/core test && pnpm --filter @bean/core typecheck`
Expected: PASS. (App/discord/teams don't compile yet — that's Tasks 3–4; do not run root typecheck here.)

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): drive models from clis.json, drop MODELS/alias layer"
```

---

### Task 3: App wiring — main, IPC, renderer cards

**Files:**
- Modify: `packages/app/src/main.ts` (~line 405, and the `registerIpc` deps at ~line 577–608)
- Modify: `packages/app/src/ipc.ts:1-9,295-301,519`
- Modify: `packages/app/src/renderer/shared/ProposalCard.tsx:17-21,68`
- Modify: `packages/app/src/renderer/components/chat/DelegateCard.tsx:83`
- Modify: `packages/app/src/renderer/components/routines/RoutinesPanel.tsx:797`

**Interfaces:**
- Consumes: `loadCliModels`, `clisFile`, `CliModels`, new `availableModels(cliModels, detected)` and `AvailableModel` (no `aliases`) from Tasks 1–2.
- Produces: `RegisterDeps`/`ModelsHandlerDeps` gain `getCliModels: () => CliModels[]`. Preload and `bean.d.ts` are unchanged (the `AvailableModel` type flows from core). Task 5's smoke test relies on the app booting with these.

- [ ] **Step 1: Load `clis.json` at boot in `main.ts`**

Add `loadCliModels, clisFile` and `type CliModels` to the existing `@bean/core` import block.
Right after the `const availableClis = detectClis(resolvedPath);` line (~405), add:

```typescript
  // Same repo-default + ~/.bean override layering as skills/persona; loaded once at boot
  // (no live reload — restart Bean after editing clis.json).
  const cliModels: CliModels[] = await loadCliModels(clisFile(projectDir), clisFile(dir));
```

Note: `projectDir` is the packaged-aware builtin dir defined at ~line 60; `dir` is `beanDir()`.
If line 405 sits in a scope where `projectDir`/`dir` aren't visible, place the load next to
where `loadConfig` is awaited (~line 428) instead — same scope as the rest of boot wiring.

In the `registerIpc(ipcMain, { ... })` deps (where `getAvailableClis: () => availableClis` is
passed at ~line 608), add:

```typescript
      getCliModels: () => cliModels,
```

- [ ] **Step 2: Update the IPC models handler**

`packages/app/src/ipc.ts`:
- Import `type CliModels` from `@bean/core` (extend the existing type import list at the top).
- Replace lines 295–301:

```typescript
export interface ModelsHandlerDeps {
  getAvailableClis: () => CliName[];
  getCliModels: () => CliModels[];
}

export function buildModelsHandler(deps: ModelsHandlerDeps) {
  return (): AvailableModel[] => availableModels(deps.getCliModels(), deps.getAvailableClis());
}
```

- `RegisterDeps` (line 519 area) already declares `getAvailableClis`; add `getCliModels: () => CliModels[];` beside it **unless** `RegisterDeps` already extends `ModelsHandlerDeps` (check the `extends` clause at line 485 — if `ModelsHandlerDeps` is in it, nothing to add).

- [ ] **Step 3: Replace `aliases` usage in the three renderer components**

`ProposalCard.tsx` lines 17–21 — replace `aliasCaption` with:

```typescript
// Which CLIs offer a model, as the row caption — shown regardless of which CLI is
// currently picked, so switching CLI later doesn't hide where a model is available.
function aliasCaption(m: PickableModel): string {
  return m.availableOn.join("  /  ");
}
```

`ProposalCard.tsx` line 68 — replace `modelObj.aliases[c] !== undefined` with `modelObj.availableOn.includes(c)`.

`DelegateCard.tsx` line 83 — replace

```tsx
{Object.entries(m.aliases).map(([cli, alias]) => `${alias} · ${cli}`).join("  /  ") || "no CLI support"}
```

with

```tsx
{m.availableOn.join("  /  ") || "no CLI support"}
```

`RoutinesPanel.tsx` line 797 — same replacement as DelegateCard.

- [ ] **Step 4: Typecheck and test the app package**

Run: `pnpm --filter @bean/app test && pnpm --filter @bean/app typecheck`
Expected: PASS. If `ipc.test.ts` (or similar) builds `ModelsHandlerDeps`, add a `getCliModels: () => [...]` stub mirroring the Task 2 fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/app
git commit -m "feat(app): wire clis.json models through boot, IPC, and pickers"
```

---

### Task 4: Discord and Teams servers

**Files:**
- Modify: `packages/discord/src/server.ts:1-8,23-60`
- Modify: `packages/teams/src/server.ts:1-8,64-100`

**Interfaces:**
- Consumes: `loadCliModels`, `clisFile` (Task 1); `BotDeps.cliModels` (Task 2).
- Produces: nothing new — both servers compile against the new `BotDeps`.

- [ ] **Step 1: Wire `cliModels` into both servers**

In each `server.ts`: add `loadCliModels, clisFile` to the `@bean/core` import list. After the
`const clis = detectClis();` line, add:

```typescript
const cliModels = await loadCliModels(clisFile(builtinDir), clisFile(dir));
```

In the `buildTeamsBot({ ... })` deps object, next to `detectClis: () => clis,`, add:

```typescript
  cliModels,
```

- [ ] **Step 2: Typecheck and test both packages**

Run: `pnpm --filter @bean/discord typecheck && pnpm --filter @bean/teams typecheck && pnpm --filter @bean/discord test && pnpm --filter @bean/teams test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/discord packages/teams
git commit -m "feat(chatops): load clis.json models in discord/teams servers"
```

---

### Task 5: Full gate, docs, memory entry

**Files:**
- Modify: `AGENTS.md` (Runtime config section — add `clis.json` line)
- Create: `.memory/project-config-driven-cli-models.md`
- Modify: `.memory/INDEX.md`

- [ ] **Step 1: Root validation gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0. Fix any straggler (search for leftovers first: `grep -rn "resolveModelAlias\|MODELS\b\|\.aliases" packages --include='*.ts' --include='*.tsx' | grep -v dist` — expect zero hits outside comments).

- [ ] **Step 2: Dev-mode smoke test**

Run: `pnpm build`, then `pnpm dev`. In the running app: open ChatWindow, ask for a delegate-style task or open the Plan window — confirm the model picker shows the labels from `.bean/clis.json` (`sonnet`, `opus`, `haiku`, `gpt-5.5`, …) and dims models of any CLI not on PATH. Then create `~/.bean/clis.json` with `[{ "provider": "claude", "models": ["opus"] }]`, restart, confirm claude's picker rows collapse to `opus` while opencode's defaults remain. Delete the test override afterwards.

This change touches spawned-CLI arg building and Electron boot resources — per AGENTS.md also verify packaged:

Run: `pnpm dist:mac`, launch `packages/app/release/mac-*/Bean.app`, confirm the model picker is populated (proves `resources/builtin/clis.json` shipped and `clisFile(projectDir)` resolves). Quit old Bean instances first.

- [ ] **Step 3: Update `AGENTS.md` runtime config list**

In the `## Runtime config (~/.bean)` section, after the `config.json` bullet, add:

```markdown
- `~/.bean/clis.json` → optional per-provider model lists overriding the repo default
  `.bean/clis.json`: `[{ "provider": "claude", "models": ["sonnet", ...] }]`. A user entry
  replaces that provider's default list; model strings are passed verbatim to `--model`.
  Providers are still code (`opencode`, `claude`) — only their model lists are config.
```

- [ ] **Step 4: Add the team-memory entry**

Create `.memory/project-config-driven-cli-models.md`:

```markdown
# Models are config, providers are code

`clis.json` (repo `.bean/` default, `~/.bean` per-provider override via `loadCliModels`)
defines which models each CLI offers. The model string is the literal `--model` value —
there is no canonical-id/alias layer anymore (`MODELS`/`resolveModelAlias` are gone; don't
reintroduce them). Adding a new model = edit clis.json, no build. Adding a new CLI =
code (argv shape in launcher/delegate + parser) **and** a `KNOWN_PROVIDERS` entry in
`cli-models.ts`. Old model-memory entries with pre-migration canonical ids (`gpt-5-5`)
simply fail `pickModel`'s support check and fall back — harmless, self-healing on next pick.
```

Link it from `.memory/INDEX.md` in the same style as the existing `project-*` entries.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md .memory
git commit -m "docs: record clis.json config layer in AGENTS.md and .memory"
```
