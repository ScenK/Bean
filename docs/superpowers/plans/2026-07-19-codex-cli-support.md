# Codex CLI Support + CLI Enable/Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI's `codex` CLI as Bean's third supported CLI (interactive launch + headless delegate), and let users enable/disable detected CLIs so disabled ones vanish from every dropdown.

**Architecture:** Extend the existing `CliName`/`LaunchMode` unions and switch branches (no provider registry). A new `CLI_NAMES` const in `launcher.ts` becomes the single source of truth for the union. Enablement is a `disabledClis` denylist in `~/.bean/config.json`, filtered at the three wiring points (app `main.ts`, discord/teams `server.ts`); everything downstream already derives from those lists.

**Tech Stack:** TypeScript ESM, vitest, Electron (app), preact (renderer). Spec: `docs/superpowers/specs/2026-07-19-codex-cli-support-design.md`.

## Global Constraints

- ESM with `verbatimModuleSyntax`: relative imports use `.js` extensions; type-only imports use `import type`.
- `strict` + `noUncheckedIndexedAccess` are on — array indexing yields `T | undefined`.
- Validation gate before claiming done: `pnpm test && pnpm typecheck` both exit 0.
- Touches spawned CLIs/PATH → also smoke-test dev AND packaged (`pnpm dist:mac`) per AGENTS.md.
- Codex flags verified against installed `codex-cli 0.144.6`: `codex [OPTIONS] [PROMPT]` (interactive), `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m/--model` all exist.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (Bean's own delegate identity does NOT apply to this dev work).

---

### Task 1: `codex` in launcher — CLI_NAMES, detectClis, launchCommand

**Files:**
- Modify: `packages/core/src/launcher.ts:9-10` (types), `:29` (detectClis list), `:61-83` (launchCommand)
- Test: `packages/core/__test__/launcher.test.ts`

**Interfaces:**
- Produces: `export const CLI_NAMES = ["opencode", "claude", "codex"] as const` and `export type CliName = (typeof CLI_NAMES)[number]` from `packages/core/src/launcher.ts`. `LaunchMode = CliName | "open"`. Later tasks import `CLI_NAMES` from `./launcher.js` (core) / `@bean/core` (app).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__test__/launcher.test.ts` (file-level `test()` style, matching existing tests):

```typescript
test("launchCommand builds the codex interactive command with a pre-sent prompt", () => {
  const req: LaunchRequest = { mode: "codex", projectPath: "/dev/acme", prompt: "do it" };
  expect(launchCommand(req)).toEqual({ command: "codex", args: ["do it"] });
});

test("launchCommand appends --model with the verbatim model string for codex", () => {
  const req: LaunchRequest = { mode: "codex", projectPath: "/p", prompt: "go", model: "gpt-5.6-sol" };
  expect(launchCommand(req).args).toEqual(["--model", "gpt-5.6-sol", "go"]);
});

test("detectClis includes codex when it is on PATH", () => {
  const path = "/usr/local/bin";
  expect(detectClis(path, () => true)).toEqual(["opencode", "claude", "codex"]);
  expect(detectClis(path, (p) => p.endsWith("/codex"))).toEqual(["codex"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/launcher.test.ts`
Expected: FAIL — `"codex"` not assignable to `LaunchMode` (type error at collect time) or assertion failures.

- [ ] **Step 3: Implement**

In `packages/core/src/launcher.ts`, replace lines 9-10:

```typescript
export const CLI_NAMES = ["opencode", "claude", "codex"] as const;
export type CliName = (typeof CLI_NAMES)[number];
export type LaunchMode = CliName | "open";
```

In `detectClis` (line 29), replace the hardcoded tuple:

```typescript
  return CLI_NAMES.filter(onPath);
```

In `launchCommand`, add a case after `case "claude"` (the `.command` script already `cd`s into projectPath, so codex mirrors claude — positional prompt, optional `--model`):

```typescript
    case "codex":
      return { command: "codex", args: [...(req.model ? ["--model", req.model] : []), req.prompt ?? ""] };
```

Also update the stale comment on line 57: `prompt?: string; // required for "opencode"/"claude"/"codex", ignored for "open"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/launcher.test.ts`
Expected: PASS (all, including pre-existing detectClis tests — they use `() => true` and now expect the 3-element list; fix the existing `detectClis reports which CLIs exist on PATH` test's first assertion to `["opencode", "claude", "codex"]`).

- [ ] **Step 5: Typecheck core, then commit**

Run: `pnpm --filter @bean/core typecheck` — expect exit 0. (App package may not typecheck yet; that's fine, it doesn't reference `"codex"`.)

```bash
git add packages/core/src/launcher.ts packages/core/__test__/launcher.test.ts
git commit -m "feat(core): add codex to CLI names and interactive launch"
```

---

### Task 2: codex headless delegate — delegateCommand, codexTailLine, codexResult

**Files:**
- Modify: `packages/core/src/delegate.ts:29-48` (delegateCommand), `:50-65` (add codex parsers next to claude's), `:131-152` (handleLine dispatch)
- Test: `packages/core/__test__/delegate.test.ts`

**Interfaces:**
- Consumes: `CliName` now includes `"codex"` (Task 1).
- Produces: `codexTailLine(event: unknown): string | undefined` and `codexResult(event: unknown): string | undefined` exported from `packages/core/src/delegate.ts`.

Real captured JSONL from `codex exec --json` (codex-cli 0.144.6) — use these shapes verbatim as test fixtures:

```
{"type":"thread.started","thread_id":"019f7b66-e859-7822-8e5f-054ec9ef3614"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll run that command now."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello-bean'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello-bean'","aggregated_output":"hello-bean\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE hello"}}
{"type":"turn.completed","usage":{"input_tokens":28264,"cached_input_tokens":23040,"output_tokens":123,"reasoning_output_tokens":0}}
```

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/delegate.test.ts` (describe/it style; import `codexTailLine`, `codexResult` in the existing import block):

```typescript
describe("delegateCommand codex", () => {
  it("maps codex to exec with json, sandbox bypass, and git-repo-check skip", () => {
    expect(delegateCommand({ cli: "codex", projectPath: "/p", prompt: "fix it" })).toEqual({
      command: "codex",
      args: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "fix it" + GIT_TRAILER_INSTRUCTION],
    });
  });

  it("appends --model with the verbatim model string", () => {
    const { args } = delegateCommand({ cli: "codex", projectPath: "/p", prompt: "go", model: "gpt-5.6-sol" });
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.6-sol");
  });
});

describe("codexTailLine", () => {
  it("returns agent_message text on item.completed", () => {
    const e = { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I'll run that command now." } };
    expect(codexTailLine(e)).toBe("I'll run that command now.");
  });

  it("turns completed command_execution into a ▸-prefixed line", () => {
    const e = { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'echo hello-bean'", exit_code: 0, status: "completed" } };
    expect(codexTailLine(e)).toBe("▸ /bin/zsh -lc 'echo hello-bean'");
  });

  it("ignores item.started, reasoning items, and turn events", () => {
    expect(codexTailLine({ type: "item.started", item: { type: "command_execution", command: "x" } })).toBeUndefined();
    expect(codexTailLine({ type: "item.completed", item: { type: "reasoning" } })).toBeUndefined();
    expect(codexTailLine({ type: "turn.completed", usage: {} })).toBeUndefined();
    expect(codexTailLine({ type: "thread.started", thread_id: "t" })).toBeUndefined();
  });
});

describe("codexResult", () => {
  it("extracts agent_message text", () => {
    const e = { type: "item.completed", item: { type: "agent_message", text: "DONE hello" } };
    expect(codexResult(e)).toBe("DONE hello");
  });

  it("returns undefined for non-message items and other events", () => {
    expect(codexResult({ type: "item.completed", item: { type: "command_execution", command: "x" } })).toBeUndefined();
    expect(codexResult({ type: "turn.completed" })).toBeUndefined();
    expect(codexResult(null)).toBeUndefined();
  });
});
```

And a `runDelegate` end-to-end case inside the existing `describe("runDelegate", ...)`, using the file's `FakeChild`/`collect()` helpers:

```typescript
  it("parses codex --json output: streams tails, resolves the last agent_message as result", () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => asChild(child));
    const { cbs, outputs, dones } = collect();
    runDelegate({ cli: "codex", projectPath: "/p", prompt: "go" }, cbs, spawnFn);
    const lines = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"working on it"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE hello"}}',
      '{"type":"turn.completed","usage":{}}',
    ];
    child.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
    child.emit("close", 0);
    expect(outputs).toEqual(["working on it", "▸ ls", "DONE hello"]);
    expect(dones).toEqual(["DONE hello"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts`
Expected: FAIL — `codexTailLine`/`codexResult` not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/delegate.ts`, add a codex branch in `delegateCommand` before the opencode return:

```typescript
  if (req.cli === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--json",
        // Full bypass, matching the claude branch above: headless runs can't answer
        // approval prompts, and the workspace-write sandbox blocks network (git push).
        "--dangerously-bypass-approvals-and-sandbox",
        // codex exec refuses non-git dirs; Bean's scratch workspace isn't a repo.
        "--skip-git-repo-check",
        ...modelArgs,
        prompt,
      ],
    };
  }
```

Add the parsers after `claudeResult` (shapes from the captured fixture above):

```typescript
export function codexTailLine(event: unknown): string | undefined {
  const e = event as { type?: unknown; item?: { type?: unknown; text?: unknown; command?: unknown } } | null;
  if (e?.type !== "item.completed" || !e.item) return undefined;
  const item = e.item;
  if (item.type === "agent_message") return typeof item.text === "string" && item.text.trim() ? item.text.trim() : undefined;
  if (item.type === "reasoning") return undefined;
  if (item.type === "command_execution" && typeof item.command === "string") return `▸ ${item.command}`;
  return typeof item.type === "string" ? `▸ ${item.type}` : undefined;
}

// Unlike claude's separate `result` event, codex's final answer is just the last
// agent_message — runDelegate keeps overwriting `result` so the last one wins.
export function codexResult(event: unknown): string | undefined {
  const e = event as { type?: unknown; item?: { type?: unknown; text?: unknown } } | null;
  if (e?.type !== "item.completed" || e.item?.type !== "agent_message") return undefined;
  return typeof e.item.text === "string" ? e.item.text : undefined;
}
```

Replace `handleLine`'s body in `runDelegate` (currently `if (req.cli !== "claude") { ... }`):

```typescript
  const handleLine = (line: string): void => {
    if (!line.trim() || settled || cancelling) return;
    rawLines.push(line);
    if (req.cli === "opencode") {
      callbacks.onOutput(line);
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      callbacks.onOutput(line);
      return;
    }
    if (req.cli === "claude") {
      const r = claudeResult(event);
      if (r !== undefined) {
        result = r;
        return;
      }
      const tail = claudeTailLine(event);
      if (tail) callbacks.onOutput(tail);
      return;
    }
    // codex: an agent_message is both the running tail AND the (latest) result.
    const r = codexResult(event);
    if (r !== undefined) result = r;
    const tail = codexTailLine(event);
    if (tail) callbacks.onOutput(tail);
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts`
Expected: PASS (all, including pre-existing claude/opencode cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/delegate.ts packages/core/__test__/delegate.test.ts
git commit -m "feat(core): codex headless delegate via codex exec --json"
```

---

### Task 3: codex provider in cli-models + default clis.json entry

**Files:**
- Modify: `packages/core/src/cli-models.ts:12`, `.bean/clis.json`
- Test: `packages/core/__test__/cli-models.test.ts`

**Interfaces:**
- Consumes: `CLI_NAMES` from `./launcher.js` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/__test__/cli-models.test.ts` (file-level `test()` style; use the file's existing temp-file helpers for writing JSON fixtures):

```typescript
test("codex is a known provider", async () => {
  // Write a defaults file containing only a codex entry, no user file (point at a missing path).
  const models = await loadCliModels(
    await writeTmp('[{ "provider": "codex", "models": ["gpt-5.6-sol"] }]'),
    "/nonexistent/clis.json",
  );
  expect(models).toEqual([{ provider: "codex", models: ["gpt-5.6-sol"] }]);
});
```

(Adapt `writeTmp` to whatever fixture helper the file already uses — it has one for the existing tests; reuse it verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/cli-models.test.ts`
Expected: FAIL — codex entry skipped as unknown provider, result `[]`.

- [ ] **Step 3: Implement**

In `packages/core/src/cli-models.ts`, replace line 12 with the shared const (add `CLI_NAMES` to the existing launcher import):

```typescript
import { CLI_NAMES, type CliName } from "./launcher.js";
```

and

```typescript
const KNOWN_PROVIDERS: readonly CliName[] = CLI_NAMES;
```

In `.bean/clis.json`, add the codex entry (model verified present on the maintainer's codex install; users override via `~/.bean/clis.json`):

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
  },
  { "provider": "codex", "models": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] }
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/cli-models.test.ts __test__/models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-models.ts packages/core/__test__/cli-models.test.ts .bean/clis.json
git commit -m "feat(core): codex provider in cli-models and default clis.json"
```

---

### Task 4: `disabledClis` config field

**Files:**
- Modify: `packages/core/src/types.ts:60-70` (BeanConfig), `packages/core/src/config.ts:41-89` (loadConfig/saveConfig)
- Test: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Produces: `BeanConfig.disabledClis: CliName[]`; `loadConfig` returns it (invalid → `[]`, unknown names dropped); `saveConfig` accepts optional `disabledClis?: string[]` and preserves the on-disk value when omitted (same pattern as `liveSessions`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/config.test.ts` (match the file's existing temp-dir fixture style):

```typescript
test("defaults disabledClis to [] and drops unknown CLI names on load", async () => {
  const file = join(tmp, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "k", disabledClis: ["codex", "vim", 42] }), "utf8");
  const cfg = await loadConfig(file, tmp);
  expect(cfg.disabledClis).toEqual(["codex"]);

  await writeFile(file, JSON.stringify({ openaiApiKey: "k" }), "utf8");
  expect((await loadConfig(file, tmp)).disabledClis).toEqual([]);

  await writeFile(file, JSON.stringify({ openaiApiKey: "k", disabledClis: "nope" }), "utf8");
  expect((await loadConfig(file, tmp)).disabledClis).toEqual([]);
});

test("saveConfig round-trips disabledClis and preserves it when the caller omits it", async () => {
  const file = join(tmp, "config.json");
  await saveConfig(file, { openaiApiKey: "k", model: "m", disabledClis: ["opencode"] });
  expect((await loadConfig(file, tmp)).disabledClis).toEqual(["opencode"]);

  // A save that doesn't know about the field must not wipe it.
  await saveConfig(file, { openaiApiKey: "k", model: "m" });
  expect((await loadConfig(file, tmp)).disabledClis).toEqual(["opencode"]);
});
```

(`tmp`, `join`, `writeFile` per the file's existing imports/fixtures.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: FAIL — `disabledClis` undefined / type error.

- [ ] **Step 3: Implement**

`packages/core/src/types.ts` — add to `BeanConfig` (with a type-only import at the top of the file):

```typescript
import type { CliName } from "./launcher.js";
```

```typescript
  /** Detected CLIs the user has switched off — a denylist so a newly installed CLI is
   * enabled by default (auto-detect sets the initial status; spec: codex-cli-support). */
  disabledClis: CliName[];
```

Also update the stale `delegateCli` comment on the line above it:

```typescript
  delegateCli: string; // "" = auto: first enabled CLI; else "claude"/"opencode"/"codex"
```

`packages/core/src/config.ts` — in `loadConfig`'s return object:

```typescript
    disabledClis: Array.isArray(parsed.disabledClis)
      ? parsed.disabledClis.filter((c): c is CliName => (CLI_NAMES as readonly string[]).includes(c as string))
      : [],
```

with `import { CLI_NAMES } from "./launcher.js";` and `import type { BeanConfig, CliName } ...` adjusted (`CliName` comes from `./launcher.js`, not types).

In `saveConfig`: add `disabledClis?: string[]` to the param type; extend the existing preserve-on-omit block to also read `disabledClis` from the existing file (rename `existingLiveSessions` handling into one parsed object):

```typescript
  let existing: Partial<BeanConfig> = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as Partial<BeanConfig>;
  } catch {
    // No existing file yet, or it's invalid — nothing to preserve.
  }
  const out = {
    openaiApiKey: config.openaiApiKey, model: config.model,
    terminalApp: config.terminalApp ?? "", editorApp: config.editorApp ?? "", delegateCli: config.delegateCli ?? "",
    systemControls: config.systemControls ?? false,
    liveSessions: config.liveSessions ?? existing.liveSessions ?? false,
    disabledClis: config.disabledClis ?? existing.disabledClis ?? [],
  };
```

(Keep the existing doc comment about preserve-on-omit; it now covers both fields.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts && pnpm --filter @bean/core typecheck`
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/__test__/config.test.ts
git commit -m "feat(core): disabledClis denylist in bean config"
```

---

### Task 5: app wiring — runtime config, IPC, main.ts enabled-CLI filter

**Files:**
- Modify: `packages/app/src/runtime-config.ts`, `packages/app/src/channels.ts:5-21` + IPC map, `packages/app/src/ipc.ts` (RegisterDeps + handler), `packages/app/src/preload.ts:18`, `packages/app/src/renderer/bean.d.ts:18`, `packages/app/src/main.ts:434-454,598-620`
- Test: `packages/app/__test__/runtime-config.test.ts`

**Interfaces:**
- Consumes: `disabledClis` from Task 4; `CLI_NAMES`/`CliName` from `@bean/core`.
- Produces:
  - `RuntimeConfig.getDisabledClis(): string[]`; `initial`/`apply`/`saveConfigFile` shapes gain `disabledClis: string[]`.
  - `ConfigView.disabledClis: string[]`, `ConfigUpdate.disabledClis: string[]` in `channels.ts`; new channel `detectedClis: "bean:detected-clis"` in the `IPC` map.
  - `RegisterDeps.getDetectedClis: () => CliName[]`; `window.bean.detectedClis(): Promise<CliName[]>`.
  - `window.bean.availableClis()` now returns **enabled** CLIs (detected minus disabled), recomputed per call.

- [ ] **Step 1: Write the failing test**

Add to `packages/app/__test__/runtime-config.test.ts` (match its existing fake-deps style):

```typescript
test("disabledClis is exposed and updated by apply", async () => {
  const saved: unknown[] = [];
  const runtime = createRuntimeConfig(
    { openaiApiKey: "", model: "m", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: ["codex"] },
    { makeChat: () => async () => "", makeConverse: () => async () => ({ reply: "" }), saveConfigFile: async (u) => { saved.push(u); } },
  );
  expect(runtime.getDisabledClis()).toEqual(["codex"]);
  await runtime.apply({ openaiApiKey: "", model: "m", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] });
  expect(runtime.getDisabledClis()).toEqual([]);
  expect(saved[0]).toMatchObject({ disabledClis: [] });
});
```

(Adjust the two `make*` fakes to whatever the existing tests in that file use — reuse their helpers.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/runtime-config.test.ts`
Expected: FAIL — `disabledClis`/`getDisabledClis` missing.

- [ ] **Step 3: Implement runtime-config + channels + IPC + preload**

`packages/app/src/runtime-config.ts` — add `disabledClis: string[]` to the `initial`, `apply`, and `saveConfigFile` object types; add state + getter + apply propagation, exactly parallel to `delegateCli`:

```typescript
  let disabledClis = initial.disabledClis;
  // in the returned object:
    getDisabledClis: () => disabledClis,
  // in apply(): pass disabledClis: update.disabledClis through saveConfigFile and
  // assign disabledClis = update.disabledClis with the other fields.
```

`packages/app/src/channels.ts` — add `disabledClis: string[];` to both `ConfigView` and `ConfigUpdate`; add to the `IPC` map:

```typescript
  detectedClis: "bean:detected-clis",
```

`packages/app/src/ipc.ts` — add to `RegisterDeps`:

```typescript
  getDetectedClis: () => CliName[];
```

and next to the existing `availableClis` registration (line ~601):

```typescript
  ipcMain.handle(IPC.detectedClis, () => deps.getDetectedClis());
```

`packages/app/src/preload.ts` — next to `availableClis`:

```typescript
  detectedClis: (): Promise<CliName[]> => ipcRenderer.invoke(IPC.detectedClis),
```

`packages/app/src/renderer/bean.d.ts` — next to `availableClis`:

```typescript
      detectedClis(): Promise<CliName[]>;
```

- [ ] **Step 4: Implement main.ts wiring**

`packages/app/src/main.ts`:

Line 434 (first-launch bootstrap) — unchanged (`saveConfig` defaults `disabledClis` to `[]`).

Line 438 — pass the loaded value into `createRuntimeConfig`:

```typescript
      { openaiApiKey: cfg.openaiApiKey, model: cfg.model, terminalApp: cfg.terminalApp, editorApp: cfg.editorApp, delegateCli: cfg.delegateCli, systemControls: cfg.systemControls, disabledClis: cfg.disabledClis },
```

After the `runtime` const, add the live filter (detection stays cached; enablement is read per call so a Settings save needs no restart):

```typescript
    const enabledClis = (): CliName[] => availableClis.filter((c) => !runtime.getDisabledClis().includes(c));
```

(`CliName` is already imported in main.ts via `@bean/core` types — add it to the type imports if not.)

Replace `resolveDelegateCli` (lines 450-454):

```typescript
    const resolveDelegateCli = (): CliName | undefined => {
      const enabled = enabledClis();
      const preferred = runtime.getDelegateCli();
      if (enabled.includes(preferred as CliName)) return preferred as CliName;
      return enabled[0];
    };
```

In the `registerIpc` deps (lines 598-620):

```typescript
      getConfig: () => ({
        // ...existing fields unchanged...
        disabledClis: runtime.getDisabledClis(),
        // paths unchanged
      }),
      getAvailableClis: () => enabledClis(),
      getDetectedClis: () => availableClis,
      delegateAvailable: () => enabledClis().length > 0,
```

- [ ] **Step 5: Run tests + typecheck, fix fallout**

Run: `pnpm --filter @bean/app test && pnpm --filter @bean/app typecheck`
Expected: `runtime-config.test.ts` passes. `ipc.test.ts` and any test constructing `ConfigView`/`ConfigUpdate`/`RegisterDeps` fixtures will fail typecheck until their fixtures gain `disabledClis: []` / `getDetectedClis: () => []` — add those fields to the fixtures (no behavioral change).

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/runtime-config.ts packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/main.ts packages/app/__test__
git commit -m "feat(app): CLI enablement filter behind availableClis + detectedClis IPC"
```

---

### Task 6: renderer — Settings CLI checkboxes + ProjectsPanel chips

**Files:**
- Modify: `packages/app/src/renderer/components/settings/SettingsWindow.tsx`, `packages/app/src/renderer/components/projects/ProjectsPanel.tsx:6-10` + chip rendering
- Test: none new (no renderer test harness for these components today); covered by typecheck + e2e + manual smoke in Task 8.

**Interfaces:**
- Consumes: `window.bean.detectedClis()`, `ConfigView.disabledClis`, `ConfigUpdate.disabledClis` (Task 5).

- [ ] **Step 1: SettingsWindow — state + load/save**

In `SettingsWindow.tsx`:

- Replace the `clis` state + fetch with detected + disabled:

```tsx
  const [detectedClis, setDetectedClis] = useState<CliName[]>([]);
  const [disabledClis, setDisabledClis] = useState<string[]>([]);
```

In the mount effect, replace `window.bean.availableClis().then(setClis);` with `window.bean.detectedClis().then(setDetectedClis);`, and in the `getConfig` callback add `setDisabledClis(c.disabledClis);`.

- Derive enabled locally (keeps the delegate dropdown consistent with unsaved toggles):

```tsx
  const enabledClis = detectedClis.filter((c) => !disabledClis.includes(c));
```

- In `onSave`, add `disabledClis` to the `saveConfig` payload.

- [ ] **Step 2: SettingsWindow — UI rows**

In the MODEL card, above the Delegate CLI row, add (only when something was detected):

```tsx
          {detectedClis.length > 0 && (
            <div class="bean-settings-row">
              <span class="bean-settings-row-label">CLIs</span>
              <div class="bean-settings-row-control">
                {detectedClis.map((c) => (
                  <label key={c} class="bean-chatops-row" title="Unchecked CLIs disappear from every launch and delegate picker.">
                    <input
                      type="checkbox"
                      checked={!disabledClis.includes(c)}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        setDisabledClis((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]));
                        setSave("idle");
                      }}
                    />
                    <span class="bean-chatops-label">{c}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
```

Change the Delegate CLI `<select>` to map over `enabledClis` instead of `clis`, and its auto option to `Auto (first enabled{enabledClis[0] ? `: ${enabledClis[0]}` : ""})`.

- [ ] **Step 3: ProjectsPanel — codex chip + enablement filter**

In `ProjectsPanel.tsx`, add the codex chip and filter by enabled CLIs:

```tsx
const LAUNCH_CHIPS: { mode: LaunchMode; label: string; needsPrompt: boolean }[] = [
  { mode: "opencode", label: "opencode", needsPrompt: true },
  { mode: "claude", label: "claude", needsPrompt: true },
  { mode: "codex", label: "codex", needsPrompt: true },
  { mode: "open", label: "Open in Editor", needsPrompt: false },
];
```

Add state + fetch (in the existing mount effect alongside `refresh()`):

```tsx
  const [clis, setClis] = useState<string[]>([]);
  // in useEffect: void window.bean.availableClis().then(setClis);
```

Where chips render (line ~203), map over a filtered list — "Open in Editor" always shown, CLI chips only when enabled:

```tsx
  const chips = LAUNCH_CHIPS.filter((c) => c.mode === "open" || clis.includes(c.mode));
```

(and change `{LAUNCH_CHIPS.map(...)}` to `{chips.map(...)}`; the `find` on line 45 can stay on `LAUNCH_CHIPS`.)

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @bean/app typecheck && pnpm build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/components/settings/SettingsWindow.tsx packages/app/src/renderer/components/projects/ProjectsPanel.tsx
git commit -m "feat(app): CLI enable checkboxes in Settings, codex launch chip"
```

---

### Task 7: chatops servers — enablement filter + NO_CLI copy

**Files:**
- Modify: `packages/discord/src/server.ts:25`, `packages/teams/src/server.ts:66`, `packages/core/src/chatops/bot.ts:113`
- Test: `packages/core/__test__/chatops-bot.test.ts` (only if the NO_CLI string is asserted there — check and update the expected text)

**Interfaces:**
- Consumes: `beanConfig.disabledClis` (Task 4).

- [ ] **Step 1: Filter detected CLIs by enablement in both servers**

`packages/discord/src/server.ts:25` and `packages/teams/src/server.ts:66` — same one-line change:

```typescript
const clis = detectClis().filter((c) => !beanConfig.disabledClis.includes(c));
```

(In discord's file the `loadConfig` call is above `detectClis`; in teams likewise — no reordering needed.)

`liveSessionsEnabled: () => clis.includes("claude")` now automatically reflects enablement: disabling claude in Settings disables live sessions on next bot start, and the existing "Live sessions are disabled here." / "Live sessions are disabled — this session wasn't started." copy is already accurate for that case. No message change needed.

- [ ] **Step 2: Update NO_CLI copy for three CLIs**

`packages/core/src/chatops/bot.ts:113`:

```typescript
const NO_CLI = "I can't run delegate tasks: no supported CLI (`claude`, `opencode`, or `codex`) is available on this machine.";
```

Run `grep -rn "neither" packages/core/__test__/chatops-bot.test.ts` — if the old string is asserted, update the assertion to the new text.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts && pnpm --filter @bean/discord test && pnpm --filter @bean/teams test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/discord/src/server.ts packages/teams/src/server.ts packages/core/src/chatops/bot.ts packages/core/__test__/chatops-bot.test.ts
git commit -m "feat(chatops): respect disabledClis; mention codex in NO_CLI copy"
```

---

### Task 8: full validation — gate + dev + packaged smoke

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across all four packages.

- [ ] **Step 2: Dev smoke — delegate path**

From the worktree root, run a direct child-process smoke of the codex delegate command against a scratch dir (no Electron needed):

```bash
node --input-type=module -e "
import { runDelegate } from './packages/core/dist/delegate.js';
runDelegate(
  { cli: 'codex', projectPath: process.env.HOME, prompt: 'Reply with exactly: BEAN-SMOKE-OK' },
  { onOutput: (l) => console.log('tail:', l), onDone: (r) => { console.log('done:', r); process.exit(0); }, onError: (e) => { console.error('err:', e.message); process.exit(1); } },
);
"
```

(Build core first: `pnpm --filter @bean/core build`.) Expected: at least one `tail:` line and `done: BEAN-SMOKE-OK`.

- [ ] **Step 3: Dev smoke — app**

Run `pnpm dev`. Verify: Settings shows CLI checkboxes for each detected CLI; unchecking one and saving removes it from the ProjectsPanel launch chips and the ProposalCard/DelegateCard CLI pickers without restart; a codex launch chip opens Terminal with the codex TUI.

- [ ] **Step 4: Packaged smoke**

Run: `pnpm dist:mac`. Quit any running Bean, launch `packages/app/release/mac-*/Bean.app`. Verify codex is detected (Finder-launched PATH goes through `loginShellPath`), the checkbox toggles work, and a codex delegate run from the chat window streams tails and completes.

- [ ] **Step 5: Commit any fixes; done**

If smoke testing surfaced fixes, commit them individually. Then the branch is ready for the finishing-a-development-branch flow.
