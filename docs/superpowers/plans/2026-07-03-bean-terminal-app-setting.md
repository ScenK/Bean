# Configurable Terminal App Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick which terminal app (Terminal, iTerm, Warp, Ghostty, …) runs the `opencode`/`claude` launches, instead of always relying on macOS's default `.command` file handler.

**Architecture:** `@bean/core`'s `launchInTerminal` gains an optional `terminalApp` parameter; when set it calls `open -a "<app>" <script>` instead of `open <script>`. The value is persisted in `~/.bean/config.json` (new `terminalApp` field), held live by `@bean/app`'s `RuntimeConfig`, and edited in the Settings window via a text field + native app picker — the same "Browse…" pattern already used for the Projects folder picker.

**Tech Stack:** TypeScript (ESM, `strict` + `noUncheckedIndexedAccess`), Electron, Preact, esbuild, Vitest. pnpm-workspace monorepo.

## Global Constraints

- Node ≥24, pnpm 11. Both packages are ESM (`"type": "module"`, `verbatimModuleSyntax`): use `.js` extensions in relative imports and `import type` for type-only imports.
- The Electron preload stays CommonJS `.cjs` (`.memory/safety-preload-must-be-cjs.md`).
- IPC channel names are declared once in `packages/app/src/channels.ts` — never string-literalled (`.memory/convention-ipc-channels.md`).
- New IO goes in `@bean/core` as pure, dependency-injected functions; Electron wiring stays in `app/` (`.memory/convention-core-is-electron-free.md`).
- `terminalApp: ""` (empty string) means "use the system default `.command` handler" — the exact current behavior. Never treat `undefined` and `""` differently; both mean "no override".
- Validation gate: `pnpm test && pnpm typecheck` both exit 0 before any task is considered done.

---

### Task 1: Core — persist `terminalApp` in `BeanConfig`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BeanConfig.terminalApp: string`; `loadConfig` defaults it to `""` when absent from disk; `saveConfig(file, config)` now takes/writes `{ openaiApiKey, model, terminalApp }`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/config.test.ts` (existing tests in this file already exercise `loadConfig`/`saveConfig` with the same tmp-dir fixture — add these alongside them):

```ts
test("loads config and defaults terminalApp to empty string", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.terminalApp).toBe("");
});

test("loadConfig preserves a configured terminalApp", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x", terminalApp: "/Applications/iTerm.app" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.terminalApp).toBe("/Applications/iTerm.app");
});

test("saveConfig round-trips terminalApp", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "sk-x", model: "m", terminalApp: "/Applications/Warp.app" });
  const cfg = await loadConfig(file, "/b");
  expect(cfg.terminalApp).toBe("/Applications/Warp.app");
});
```

Update the existing "saveConfig writes only openaiApiKey and model (no beanDir)" test — it now writes a third field, so rename it and widen the assertion:

```ts
test("saveConfig writes only openaiApiKey, model and terminalApp (no beanDir)", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "sk-x", model: "m", terminalApp: "" });
  const parsed = JSON.parse(await readFile(file, "utf8"));
  expect(Object.keys(parsed).sort()).toEqual(["model", "openaiApiKey", "terminalApp"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: FAIL — `saveConfig` called without required `terminalApp` is a type error surfaced by vitest's esbuild transform, and `cfg.terminalApp` assertions fail (`undefined` !== `""`).

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add the field to `BeanConfig`:

```ts
export interface BeanConfig {
  openaiApiKey: string;
  model: string;
  terminalApp: string; // "" = use the system default handler for .command files
  beanDir: string; // resolved absolute path to ~/.bean
}
```

In `packages/core/src/config.ts`, update `loadConfig`'s return and `saveConfig`'s signature:

```ts
export async function loadConfig(file: string, beanDirPath: string): Promise<BeanConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Bean config missing: ${file}`);
  }
  let parsed: Partial<BeanConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<BeanConfig>;
  } catch {
    throw new Error(`Bean config invalid: ${file}`);
  }
  return {
    openaiApiKey: parsed.openaiApiKey ?? "",
    model: parsed.model ?? "gpt-4o-mini",
    terminalApp: parsed.terminalApp ?? "",
    beanDir: beanDirPath,
  };
}

export async function saveConfig(
  file: string,
  config: { openaiApiKey: string; model: string; terminalApp: string },
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const out = { openaiApiKey: config.openaiApiKey, model: config.model, terminalApp: config.terminalApp };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/__test__/config.test.ts
git commit -m "feat(core): persist terminalApp in BeanConfig"
```

---

### Task 2: Core — `launchInTerminal` opens the chosen terminal app

**Files:**
- Modify: `packages/core/src/launcher.ts`
- Test: `packages/core/__test__/launcher.test.ts`

**Interfaces:**
- Consumes: nothing new (still pure, DI'd via `spawnFn`/`writeScript`).
- Produces: `launchInTerminal(req, spawnFn?, writeScript?, terminalApp?)` — a 4th, optional `terminalApp: string` param. When truthy, `open` is called with `["-a", terminalApp, scriptPath]`; when falsy (`""` or `undefined`), behavior is unchanged (`[scriptPath]`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/launcher.test.ts`:

```ts
test("opencode mode opens the script with a configured terminal app via `open -a`", () => {
  const child = fakeChild();
  const spawnFn = vi.fn<LaunchSpawnFn>(() => child as never);
  let written: { path: string; content: string } | undefined;
  const writeScript = (path: string, content: string): void => { written = { path, content }; };

  launchInTerminal(
    { mode: "opencode", projectPath: "/dev/acme", prompt: "do it" },
    spawnFn,
    writeScript,
    "/Applications/iTerm.app",
  );

  expect(spawnFn).toHaveBeenCalledWith("open", ["-a", "/Applications/iTerm.app", written?.path]);
});

test("an empty terminalApp falls back to the system default handler (no -a flag)", () => {
  const child = fakeChild();
  const spawnFn = vi.fn<LaunchSpawnFn>(() => child as never);
  const writeScript = vi.fn();

  launchInTerminal({ mode: "opencode", projectPath: "/p", prompt: "go" }, spawnFn, writeScript, "");

  const [, args] = spawnFn.mock.calls[0]!;
  expect(args).not.toContain("-a");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/launcher.test.ts`
Expected: FAIL — the first new test's `expect(spawnFn).toHaveBeenCalledWith(...)` doesn't match today's `spawnFn("open", [written?.path])` call (no `-a` flag support yet).

- [ ] **Step 3: Implement**

In `packages/core/src/launcher.ts`, change `launchInTerminal`'s signature and the final `open` call:

```ts
export function launchInTerminal(
  req: LaunchRequest,
  spawnFn: LaunchSpawnFn = defaultSpawn,
  writeScript: ScriptWriter = defaultScriptWriter,
  terminalApp?: string,
): void {
  const { command, args } = launchCommand(req);

  if (req.mode === "open") {
    fireAndForget(spawnFn(command, args));
    return;
  }

  const scriptPath = join(tmpdir(), `bean-run-${randomUUID()}.command`);
  const cmdLine = [command, ...args].map(shQuote).join(" ");
  writeScript(
    scriptPath,
    `#!/bin/sh\ncd ${shQuote(req.projectPath)}\n${cmdLine}\necho\necho "[bean] done — press Enter to close"\nread _\n`,
  );
  // An explicit terminalApp opens the script with that app (`open -a`); empty/unset falls back
  // to macOS's own default handler for .command files, exactly like before this option existed.
  const openArgs = terminalApp ? ["-a", terminalApp, scriptPath] : [scriptPath];
  fireAndForget(spawnFn("open", openArgs));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/launcher.test.ts`
Expected: PASS (all launcher tests, including the pre-existing ones at lines 34-46 which call `launchInTerminal` with only 3 args — `terminalApp` stays `undefined` and takes the falsy branch).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/launcher.ts packages/core/__test__/launcher.test.ts
git commit -m "feat(core): launchInTerminal opens a configured terminal app via open -a"
```

---

### Task 3: App — `RuntimeConfig` holds `terminalApp` live

**Files:**
- Modify: `packages/app/src/runtime-config.ts`
- Test: `packages/app/__test__/runtime-config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RuntimeConfig.getTerminalApp(): string`; `RuntimeConfigDeps.saveConfigFile` and `RuntimeConfig.apply`/`createRuntimeConfig`'s `initial`/`update` params widen to include `terminalApp: string`.

- [ ] **Step 1: Write the failing test**

Replace the full contents of `packages/app/__test__/runtime-config.test.ts` with (this widens every existing `createRuntimeConfig`/`apply` call to include `terminalApp`, and adds the new test at the end):

```ts
import { expect, test } from "vitest";
import { createRuntimeConfig } from "../src/runtime-config.js";

test("apply saves config and rebuilds clients with the new key", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string }[] = [];
  const madeChat: string[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "" },
    {
      makeChat: (k) => { madeChat.push(k); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getModel()).toBe("gpt-4o-mini");
  expect(rt.getApiKey()).toBe("sk-old");
  expect(madeChat).toEqual(["sk-old"]);

  await rt.apply({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "" });

  expect(saved).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "" }]);
  expect(rt.getModel()).toBe("gpt-5");
  expect(rt.getApiKey()).toBe("sk-new");
  expect(madeChat).toEqual(["sk-old", "sk-new"]);
});

test("the stable chat wrapper delegates to the current client after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "a", model: "m", terminalApp: "" },
    {
      makeChat: (k) => (async () => "R:" + k) as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );
  const wrapper = rt.chat;
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:a");
  await rt.apply({ openaiApiKey: "b", model: "m", terminalApp: "" });
  // same wrapper reference, new underlying client
  expect(rt.chat).toBe(wrapper);
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:b");
});

test("apply builds clients before persisting: a failing makeChat leaves disk and state untouched", async () => {
  let saved = 0;
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "" },
    {
      makeChat: (k) => { if (k === "bad") throw new Error("bad key"); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => { saved++; },
    },
  );
  await expect(rt.apply({ openaiApiKey: "bad", model: "gpt-5", terminalApp: "" })).rejects.toThrow("bad key");
  expect(saved).toBe(0);          // never persisted
  expect(rt.getApiKey()).toBe("sk-old");  // state unchanged
  expect(rt.getModel()).toBe("gpt-4o-mini");
});

test("getTerminalApp reflects the initial value and updates after apply", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string }[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "" },
    {
      makeChat: () => (async () => "") as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getTerminalApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app" });

  expect(rt.getTerminalApp()).toBe("/Applications/iTerm.app");
  expect(saved).toEqual([{ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/runtime-config.test.ts`
Expected: FAIL — `rt.getTerminalApp is not a function`, plus TS errors on the widened call sites once Step 1's edits are in place but Step 3's implementation isn't yet.

- [ ] **Step 3: Implement**

In `packages/app/src/runtime-config.ts`:

```ts
export interface RuntimeConfigDeps {
  makeChat: (apiKey: string) => RouterDeps["chat"];
  makeConverse: (apiKey: string) => ConverseDeps["chat"];
  saveConfigFile: (update: { openaiApiKey: string; model: string; terminalApp: string }) => Promise<void>;
}

export interface RuntimeConfig {
  chat: RouterDeps["chat"];
  converse: ConverseDeps["chat"];
  getModel: () => string;
  getApiKey: () => string;
  getTerminalApp: () => string;
  apply: (update: { openaiApiKey: string; model: string; terminalApp: string }) => Promise<void>;
}

export function createRuntimeConfig(
  initial: { openaiApiKey: string; model: string; terminalApp: string },
  deps: RuntimeConfigDeps,
): RuntimeConfig {
  let apiKey = initial.openaiApiKey;
  let model = initial.model;
  let terminalApp = initial.terminalApp;
  let chatClient = apiKey ? deps.makeChat(apiKey) : null;
  let converseClient = apiKey ? deps.makeConverse(apiKey) : null;

  return {
    chat: ((...args: Parameters<RouterDeps["chat"]>) => {
      if (!chatClient) throw new Error("No OpenAI API key configured — add one in Settings.");
      return chatClient(...args);
    }) as RouterDeps["chat"],
    converse: ((...args: Parameters<ConverseDeps["chat"]>) => {
      if (!converseClient) throw new Error("No OpenAI API key configured — add one in Settings.");
      return converseClient(...args);
    }) as ConverseDeps["chat"],
    getModel: () => model,
    getApiKey: () => apiKey,
    getTerminalApp: () => terminalApp,
    apply: async (update) => {
      const nextChatClient = update.openaiApiKey ? deps.makeChat(update.openaiApiKey) : null;
      const nextConverseClient = update.openaiApiKey ? deps.makeConverse(update.openaiApiKey) : null;
      await deps.saveConfigFile({ openaiApiKey: update.openaiApiKey, model: update.model, terminalApp: update.terminalApp });
      apiKey = update.openaiApiKey;
      model = update.model;
      terminalApp = update.terminalApp;
      chatClient = nextChatClient;
      converseClient = nextConverseClient;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/runtime-config.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/runtime-config.ts packages/app/__test__/runtime-config.test.ts
git commit -m "feat(app): RuntimeConfig holds terminalApp live"
```

---

### Task 4: App — IPC plumbing (`channels.ts`, `ipc.ts`)

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `LaunchRequest`, `LaunchSpawnFn` from `@bean/core` (unchanged); `RuntimeConfig.getTerminalApp` (Task 3, wired in Task 5).
- Produces: `ConfigView.terminalApp: string`, `ConfigUpdate.terminalApp: string`, `IPC.pickTerminalApp: "bean:pick-terminal-app"`; `LaunchHandlerDeps.getTerminalApp?: () => string` threaded into `buildLaunchHandler`; `registerIpc` handles `IPC.pickTerminalApp` with a native `.app` picker.

- [ ] **Step 1: Write the failing tests**

Add a new test right after "launch handler spawns via the injected spawnLaunch (open mode, no script)" in `packages/app/__test__/ipc.test.ts`:

```ts
test("launch handler forwards getTerminalApp() into launchInTerminal's terminalApp arg", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch, getTerminalApp: () => "/Applications/Warp.app" });

  handler({ mode: "opencode", projectPath: "/p", prompt: "go" });

  // "open" is called with the -a flag naming the configured app.
  expect(spawnLaunch).toHaveBeenCalledWith("open", expect.arrayContaining(["-a", "/Applications/Warp.app"]));
});
```

Replace the "config get handler returns the injected view" test with:

```ts
test("config get handler returns the injected view", () => {
  const view: ConfigView = {
    openaiApiKey: "sk-x", model: "m", terminalApp: "",
    paths: { config: "/b/config.json", skills: "/b/skills", projects: "/b/projects.json", persona: "/b/persona.json" },
  };
  const handlers = buildConfigHandlers({ getConfig: () => view, applyConfig: async () => {} });
  expect(handlers.get()).toBe(view);
});
```

Replace the "config save handler forwards the update to applyConfig" test with:

```ts
test("config save handler forwards the update to applyConfig", async () => {
  const applied: ConfigUpdate[] = [];
  const handlers = buildConfigHandlers({
    getConfig: () => ({ openaiApiKey: "", model: "", terminalApp: "", paths: { config: "", skills: "", projects: "", persona: "" } }),
    applyConfig: async (u) => { applied.push(u); },
  });
  await handlers.save({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "/Applications/iTerm.app" });
  expect(applied).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "/Applications/iTerm.app" }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — TS errors on the widened `ConfigView`/`ConfigUpdate` literals, and the new forwarding test fails since `buildLaunchHandler` doesn't read `getTerminalApp` yet.

- [ ] **Step 3: Implement**

In `packages/app/src/channels.ts`:

```ts
export interface ConfigView {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  paths: { config: string; skills: string; projects: string; persona: string };
}
export interface ConfigUpdate {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
}
```
Add one entry to the `IPC` const, next to `pickProjectFolder`:
```ts
pickTerminalApp: "bean:pick-terminal-app",
```

In `packages/app/src/ipc.ts`, widen `LaunchHandlerDeps` and `buildLaunchHandler` (around line 116-122):

```ts
export interface LaunchHandlerDeps {
  spawnLaunch?: LaunchSpawnFn;
  getTerminalApp?: () => string;
}

export function buildLaunchHandler(deps: LaunchHandlerDeps) {
  return (req: LaunchRequest): void => launchInTerminal(req, deps.spawnLaunch, undefined, deps.getTerminalApp?.());
}
```

Add `getTerminalApp: () => string;` to `RegisterDeps` (next to the existing `getConfig`/`applyConfig` fields around line 176-179), and inside `registerIpc`, register a picker handler right after the existing `pickProjectFolder` handler (around line 206):

```ts
  // Native .app picker for the Settings "Terminal App" field — same shape as pickProjectFolder,
  // just filtered to application bundles and defaulted to /Applications.
  ipcMain.handle(IPC.pickTerminalApp, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ["openFile"] as const,
      filters: [{ name: "Applications", extensions: ["app"] }],
      defaultPath: "/Applications",
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? undefined : result.filePaths[0];
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS (all ipc tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): thread terminalApp through IPC + add pickTerminalApp picker"
```

---

### Task 5: App — wire `main.ts`, `preload.ts`, `bean.d.ts`

**Files:**
- Modify: `packages/app/src/main.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`

**Interfaces:**
- Consumes: `RuntimeConfig.getTerminalApp` (Task 3), `IPC.pickTerminalApp` (Task 4).
- Produces: `window.bean.pickTerminalApp(): Promise<string | undefined>`; the app's `getConfig`/`saveConfig` round-trip now includes `terminalApp` end-to-end; no behavior change for existing callers (default is `""`).

This task has no dedicated test file (neither `main.ts` nor `preload.ts` has existing unit coverage — consistent with the rest of this file, e.g. `pickProjectFolder`'s wiring is untested the same way). Verification is the manual check at the end of Task 6.

- [ ] **Step 1: Update `main.ts`**

Three edits in `packages/app/src/main.ts`:

1. The first-launch bootstrap default (line 91) gains the new field:
```ts
if (!existsSync(cfgPath)) await saveConfig(cfgPath, { openaiApiKey: "", model: "gpt-4o-mini", terminalApp: "" });
```

2. `createRuntimeConfig`'s initial value (lines 94-101) gains `terminalApp`:
```ts
const runtime = createRuntimeConfig(
  { openaiApiKey: cfg.openaiApiKey, model: cfg.model, terminalApp: cfg.terminalApp },
  {
    makeChat: makeOpenAIChat,
    makeConverse: makeOpenAIConverse,
    saveConfigFile: (update) => saveConfig(configFile(dir), update),
  },
);
```

3. The `registerIpc(...)` call's `getConfig` (lines 113-122) and a new `getTerminalApp` entry:
```ts
      getConfig: () => ({
        openaiApiKey: runtime.getApiKey(),
        model: runtime.getModel(),
        terminalApp: runtime.getTerminalApp(),
        paths: {
          config: configFile(dir),
          skills: skillsDir(dir),
          projects: projectsFile(dir),
          persona: personaFile(dir),
        },
      }),
      applyConfig: (update) => runtime.apply(update),
      getTerminalApp: () => runtime.getTerminalApp(),
```
(`getTerminalApp` goes right after `applyConfig`, alongside the other `runtime`-backed getters.)

- [ ] **Step 2: Update `preload.ts`**

Add one bridge method, next to `pickProjectFolder` (line 35):

```ts
  pickTerminalApp: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.pickTerminalApp),
```

- [ ] **Step 3: Update `bean.d.ts`**

Add the matching signature to the `window.bean` interface, next to `pickProjectFolder` (line 29):

```ts
      pickTerminalApp(): Promise<string | undefined>;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @bean/app typecheck`
Expected: exits 0 — this task is pure wiring with no new logic, so the compiler is the check.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/main.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts
git commit -m "feat(app): wire terminalApp through main.ts and the preload bridge"
```

---

### Task 6: Renderer — Settings window "Terminal App" field

**Files:**
- Modify: `packages/app/src/renderer/components/settings/SettingsWindow.tsx`

**Interfaces:**
- Consumes: `window.bean.getConfig()`/`saveConfig()`/`pickTerminalApp()` (Tasks 4-5).
- Produces: no new exports — this is the terminal task in the plan.

No test framework covers renderer UI in this repo (per `AGENTS.md`/existing plans' convention) — this task ends with a manual verification checklist instead of an automated test.

- [ ] **Step 1: Add state and load/save wiring**

In `packages/app/src/renderer/components/settings/SettingsWindow.tsx`, add a `terminalApp` state next to `model` (line 17):

```tsx
  const [terminalApp, setTerminalApp] = useState("");
```

In the `useEffect`'s `getConfig()` callback (lines 25-29), also populate it:

```tsx
    window.bean.getConfig().then((c: ConfigView) => {
      setApiKey(c.openaiApiKey);
      setModel(c.model);
      setTerminalApp(c.terminalApp);
      setPaths(c.paths);
    });
```

In `onSave` (lines 34-44), include it in the payload:

```tsx
      await window.bean.saveConfig({ openaiApiKey: apiKey.trim(), model: model.trim(), terminalApp: terminalApp.trim() });
```

Add a browse handler alongside `onSave`:

```tsx
  const browseTerminalApp = async (): Promise<void> => {
    const path = await window.bean.pickTerminalApp();
    if (path) { setTerminalApp(path); setSave("idle"); }
  };
```

- [ ] **Step 2: Add the field to the form**

Insert a new `bean-field` block right after the MODEL NAME field (after line 69, before the THEME field):

```tsx
        <label class="bean-field">
          <span class="bean-field-label">TERMINAL APP</span>
          <div class="bean-browse-row">
            <input
              class="bean-input"
              type="text"
              value={terminalApp}
              placeholder="System Default"
              onInput={(e) => { setTerminalApp((e.target as HTMLInputElement).value); setSave("idle"); }}
            />
            <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browseTerminalApp()}>Browse…</button>
          </div>
        </label>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bean/app typecheck`
Expected: exits 0.

- [ ] **Step 4: Build and manually verify**

Run: `pnpm build && pnpm dev` (from the repo root)

Manual checklist:
1. Open the avatar's right-click menu → Settings. Confirm a "TERMINAL APP" field shows placeholder "System Default" (empty on first run).
2. Click Browse…, pick an installed terminal app's `.app` bundle (e.g. `/Applications/iTerm.app`) from `/Applications`. Confirm the field fills with that path.
3. Click Save. Confirm "Saved ✓" appears.
4. From the Projects panel, launch an `opencode run` or `claude -p` task against any project. Confirm it opens in the chosen terminal app, not the previous default.
5. Reopen Settings, clear the TERMINAL APP field back to empty, Save. Launch again — confirm it now falls back to the system default handler (the original behavior).
6. Quit and relaunch Bean (`pnpm dev` again). Reopen Settings — confirm the last-saved `terminalApp` value persisted across restart (proves the `~/.bean/config.json` round-trip).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/components/settings/SettingsWindow.tsx
git commit -m "feat(app): add Terminal App picker to Settings window"
```

---

### Task 7: Final validation

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all packages' vitest suites pass, exit 0.

- [ ] **Step 2: Full typecheck**

Run: `pnpm typecheck`
Expected: exits 0 across both packages.

- [ ] **Step 3: Commit (only if any stray changes remain)**

```bash
git status --short
```
Expected: clean (everything already committed in Tasks 1-6). If not, stage and commit any leftovers with an appropriate message.
