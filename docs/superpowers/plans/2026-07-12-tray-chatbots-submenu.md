# Tray "Chat Bots" Submenu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Chat Bots" submenu to Bean's tray menu (between Settings and Persona) that lets the user start/stop the Discord and Teams chatops bots directly from the tray, without opening Settings.

**Architecture:** A new pure function `chatopsMenuRows()` in `packages/app/src/chatops-tray-menu.ts` turns the existing `chatopsServers.status()` snapshot into display rows (label, colored-dot state, checked, optional error). `main.ts` wraps its existing tray-menu template in a `buildTrayMenu()` function that maps those rows into Electron `checkbox`-type `MenuItem`s wired to `chatopsServers.start/stop`, and rebuilds the whole tray menu fresh right before every `popUpContextMenu` call so the checkboxes/dots are always current. No new IPC — the tray menu is built in the main process, where `chatopsServers` already lives.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`), Electron `Menu`/`Tray`, Vitest.

## Global Constraints

- Files are kebab-case `.ts`; both packages are ESM — use `.js` extensions in relative imports and `import type` for type-only imports (per `AGENTS.md` Code Style).
- `strict` + `noUncheckedIndexedAccess` are on — handle `T | undefined` from array/index access.
- No new IPC channel, preload API, or renderer change — this is entirely `@bean/app` main-process wiring plus one new pure, Electron-free helper module.
- No right-click anywhere (tray or avatar) — this is a left-click submenu only, per `.memory/project-settings-about-context-menu.md`.
- Colored state indicators come from Unicode dot characters in the menu-item label (🟢/⚪/🔴), not from `icon:` — `nativeImage.createMenuSymbol` only renders monochrome template images.
- Run `pnpm test && pnpm typecheck` before considering any task done (per `CLAUDE.md`).

---

### Task 1: `chatopsMenuRows()` pure helper + tests

**Files:**
- Create: `packages/app/src/chatops-tray-menu.ts`
- Test: `packages/app/__test__/chatops-tray-menu.test.ts`

**Interfaces:**
- Consumes: `ChatopsBot` (`"discord" | "teams"`) and `ChatopsState` (`{ running: boolean; error?: string }`) from `packages/app/src/chatops-servers.ts` (already exist, unmodified).
- Produces: `ChatopsMenuRow` type and `chatopsMenuRows(status: Record<ChatopsBot, ChatopsState>): ChatopsMenuRow[]`, consumed by Task 2's `main.ts` changes. Shape:
  ```ts
  export interface ChatopsMenuRow {
    bot: ChatopsBot;
    label: string;
    dot: "🟢" | "⚪" | "🔴";
    checked: boolean;
    error?: string;
  }
  ```
  Row order is always `["discord", "teams"]`. `dot` is `"🔴"` whenever `error` is set (regardless of `running`), else `"🟢"` when `running`, else `"⚪"`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/__test__/chatops-tray-menu.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chatopsMenuRows } from "../src/chatops-tray-menu.js";
import type { ChatopsState } from "../src/chatops-servers.js";

const status = (discord: ChatopsState, teams: ChatopsState) => ({ discord, teams });

describe("chatopsMenuRows", () => {
  it("shows a gray dot and unchecked when a bot is stopped", () => {
    const rows = chatopsMenuRows(status({ running: false }, { running: false }));
    expect(rows).toEqual([
      { bot: "discord", label: "Discord", dot: "⚪", checked: false },
      { bot: "teams", label: "Teams", dot: "⚪", checked: false },
    ]);
  });

  it("shows a green dot and checked when a bot is running", () => {
    const rows = chatopsMenuRows(status({ running: true }, { running: false }));
    expect(rows[0]).toEqual({ bot: "discord", label: "Discord", dot: "🟢", checked: true });
  });

  it("shows a red dot and carries the error message when a bot errored", () => {
    const rows = chatopsMenuRows(status({ running: false, error: "boom" }, { running: false }));
    expect(rows[0]).toEqual({ bot: "discord", label: "Discord", dot: "🔴", checked: false, error: "boom" });
  });

  it("prefers the red error dot even if running is somehow still true", () => {
    const rows = chatopsMenuRows(status({ running: true, error: "boom" }, { running: false }));
    expect(rows[0]!.dot).toBe("🔴");
  });

  it("always returns discord then teams, in that order", () => {
    const rows = chatopsMenuRows(status({ running: false }, { running: true }));
    expect(rows.map((r) => r.bot)).toEqual(["discord", "teams"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/chatops-tray-menu.test.ts`
Expected: FAIL — `Cannot find module '../src/chatops-tray-menu.js'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/app/src/chatops-tray-menu.ts`:

```ts
import type { ChatopsBot, ChatopsState } from "./chatops-servers.js";

export interface ChatopsMenuRow {
  bot: ChatopsBot;
  label: string;
  dot: "🟢" | "⚪" | "🔴";
  checked: boolean;
  error?: string;
}

const BOT_LABELS: Record<ChatopsBot, string> = { discord: "Discord", teams: "Teams" };
const BOT_ORDER: ChatopsBot[] = ["discord", "teams"];

export function chatopsMenuRows(status: Record<ChatopsBot, ChatopsState>): ChatopsMenuRow[] {
  return BOT_ORDER.map((bot) => {
    const s = status[bot];
    const dot: ChatopsMenuRow["dot"] = s.error ? "🔴" : s.running ? "🟢" : "⚪";
    return { bot, label: BOT_LABELS[bot], dot, checked: s.running, ...(s.error ? { error: s.error } : {}) };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/chatops-tray-menu.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/chatops-tray-menu.ts packages/app/__test__/chatops-tray-menu.test.ts
git commit -m "feat: add chatopsMenuRows helper for tray Chat Bots display"
```

---

### Task 2: Wire the "Chat Bots" submenu into the tray

**Files:**
- Modify: `packages/app/src/main.ts:5` (imports), `:52` (hoist `chatopsServers` binding), `:84-103` (tray menu build + click handler), `:389-398` (assign instead of declare `chatopsServers`)

**Interfaces:**
- Consumes: `chatopsMenuRows` and `ChatopsMenuRow` from Task 1 (`./chatops-tray-menu.js`); `createChatopsServers`'s returned `{ status, start, stop, stopAll }` (unchanged, already imported).
- Produces: nothing consumed by later tasks — this is the final integration task.

**Why the hoist:** `chatopsServers` is currently declared with `const` *inside* the `try { ... }` block that starts at `main.ts:354` (after an `await loadConfig(...)`), so it's block-scoped to that `try` and invisible outside it. The tray menu (built at `main.ts:84-103`, long before that `try` block runs) needs to read `chatopsServers.status()` inside its click handler. The existing `openComponent` (defined at `main.ts:135`, also *after* the tray menu template that already calls it at line 86) shows this pattern is safe *as long as the variable lives in the outer function's scope, not inside a nested block* — click handlers only run on user interaction, long after the whole `whenReady().then(...)` callback has finished its synchronous/awaited setup. So: hoist a `let chatopsServers: ReturnType<typeof createChatopsServers> | undefined;` declaration up to the outer scope (next to `const avatar = createAvatarWindow();`), and change the `try` block to *assign* rather than declare it.

- [ ] **Step 1: Add the import**

In `packages/app/src/main.ts`, change line 5 from:

```ts
import { createChatopsServers } from "./chatops-servers.js";
```

to:

```ts
import { createChatopsServers } from "./chatops-servers.js";
import { chatopsMenuRows } from "./chatops-tray-menu.js";
```

Also add `MenuItemConstructorOptions` to the existing `electron` type-only usage. Since `main.ts` line 6 already imports value bindings from `"electron"` (`Menu`, `nativeImage`, etc.), add a separate type-only import right after it:

```ts
import type { MenuItemConstructorOptions } from "electron";
```

- [ ] **Step 2: Hoist the `chatopsServers` binding**

In `packages/app/src/main.ts`, immediately after this existing line (currently line 53):

```ts
  const avatar = createAvatarWindow();
```

add:

```ts
  // Hoisted out of the `try` block below (where it's created) so the tray menu's click
  // handler — built further up in this function, long before that `try` runs — can read
  // it. Safe because click handlers only fire on user interaction, after this whole
  // whenReady() callback (including the try block) has finished running.
  let chatopsServers: ReturnType<typeof createChatopsServers> | undefined;
```

- [ ] **Step 3: Turn the `try` block's declaration into an assignment**

In `packages/app/src/main.ts`, find (currently lines 389-398):

```ts
    const chatopsRoot = app.isPackaged ? process.resourcesPath : dirname(projectBeanDir());
    const chatopsServers = createChatopsServers({
      repoRoot: chatopsRoot,
      resolvedPath,
      send: (event) => broadcast(IPC.chatopsEvent, event),
      ...(app.isPackaged ? {
        serverEntries: { discord: "chatops/discord/server.js", teams: "chatops/teams/server.js" },
        extraEnv: { BEAN_BUILTIN_DIR: projectDir },
      } : {}),
    });
```

Replace with (only the second line changes — `const` → assignment to the hoisted variable):

```ts
    const chatopsRoot = app.isPackaged ? process.resourcesPath : dirname(projectBeanDir());
    chatopsServers = createChatopsServers({
      repoRoot: chatopsRoot,
      resolvedPath,
      send: (event) => broadcast(IPC.chatopsEvent, event),
      ...(app.isPackaged ? {
        serverEntries: { discord: "chatops/discord/server.js", teams: "chatops/teams/server.js" },
        extraEnv: { BEAN_BUILTIN_DIR: projectDir },
      } : {}),
    });
```

- [ ] **Step 4: Build the submenu and wrap the tray menu in a function**

In `packages/app/src/main.ts`, find the existing block (currently lines 84-90):

```ts
  const symbol = (name: string) => nativeImage.createMenuSymbol(name);
  const trayMenu = Menu.buildFromTemplate([
    { label: "Settings", icon: symbol("gearshape"), accelerator: "Cmd+,", click: () => openComponent("settings") },
    { label: "Persona", icon: symbol("person.crop.circle"), accelerator: "Cmd+P", click: () => openComponent("persona") },
    { label: "About", icon: symbol("info.circle"), click: () => openComponent("about") },
    { label: "Exit", icon: symbol("rectangle.portrait.and.arrow.right"), accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
```

Replace with:

```ts
  const symbol = (name: string) => nativeImage.createMenuSymbol(name);
  // Discord/Teams start/stop, folded into one "Chat Bots" submenu item instead of one tray
  // row per bot. Mirrors SettingsWindow.tsx's own Start/Stop toggle — same chatopsServers
  // object, so both surfaces stay in sync. Rebuilt fresh in buildTrayMenu() below (not just
  // once here) so the checkbox/dot state is current every time the tray menu opens.
  const buildChatopsSubmenu = (): MenuItemConstructorOptions[] => {
    const status = chatopsServers?.status() ?? { discord: { running: false }, teams: { running: false } };
    const items: MenuItemConstructorOptions[] = [];
    for (const row of chatopsMenuRows(status)) {
      items.push({
        label: `${row.dot} ${row.label}`,
        type: "checkbox",
        checked: row.checked,
        click: () => (row.checked ? chatopsServers?.stop(row.bot) : chatopsServers?.start(row.bot)),
      });
      if (row.error) items.push({ label: `⚠️ ${row.error}`, enabled: false });
    }
    return items;
  };
  const buildTrayMenu = (): Menu => Menu.buildFromTemplate([
    { label: "Settings", icon: symbol("gearshape"), accelerator: "Cmd+,", click: () => openComponent("settings") },
    { label: "Chat Bots", icon: symbol("message"), submenu: buildChatopsSubmenu() },
    { label: "Persona", icon: symbol("person.crop.circle"), accelerator: "Cmd+P", click: () => openComponent("persona") },
    { label: "About", icon: symbol("info.circle"), click: () => openComponent("about") },
    { label: "Exit", icon: symbol("rectangle.portrait.and.arrow.right"), accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
  let trayMenu = buildTrayMenu();
```

- [ ] **Step 5: Rebuild the menu before every popup**

In `packages/app/src/main.ts`, find the existing click handler (currently lines 96-103):

```ts
  tray.on("click", () => {
    if (!avatar.isDestroyed() && !avatar.isVisible()) {
      avatar.show();
      avatar.focus();
      return;
    }
    tray?.popUpContextMenu(trayMenu);
  });
```

Replace with:

```ts
  tray.on("click", () => {
    if (!avatar.isDestroyed() && !avatar.isVisible()) {
      avatar.show();
      avatar.focus();
      return;
    }
    trayMenu = buildTrayMenu();
    tray?.popUpContextMenu(trayMenu);
  });
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @bean/app exec tsc --noEmit`
Expected: no errors. (If `chatopsServers` reports "used before assigned" anywhere, confirm Step 2's `let` declaration landed *before* Step 4's `buildChatopsSubmenu` — TypeScript's definite-assignment analysis only looks at the linear code path, not closures, so this should pass; a real error here would mean the hoist landed in the wrong scope.)

- [ ] **Step 7: Run full test suite**

Run: `pnpm test && pnpm typecheck`
Expected: all packages PASS, 0 typecheck errors.

- [ ] **Step 8: Manual dev verification**

Run: `pnpm dev`
Then:
1. Click the tray icon — confirm "Chat Bots" appears between "Settings" and "Persona", with a submenu arrow.
2. Hover/open it — confirm two checkbox rows, "⚪ Discord" and "⚪ Teams" (or 🟢 if already running from a prior session), both unchecked when stopped.
3. Click "Discord" — confirm it starts (checkbox becomes checked, dot turns 🟢 next time you reopen the tray menu; if `packages/discord/dist/server.js` isn't built, confirm instead an `⚠️ Not built — run "pnpm --filter @bean/discord build" first.` disabled line appears below it and the dot is 🔴).
4. Open Settings (tray → Settings) and confirm its "Chat bots" section shows the same running/stopped state for the bot you just toggled from the tray.
5. Click "Discord" again from the tray to stop it; confirm both the tray dot and the Settings panel row flip back to stopped.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/main.ts
git commit -m "feat: expose Discord/Teams start-stop as a tray Chat Bots submenu"
```

---

## Self-Review Notes

- **Spec coverage:** Submenu placement (between Settings/Persona) ✓ Task 2 Step 4; checkbox + colored dot ✓ Task 1 + Task 2 Step 4; error line ✓ Task 1's `error` field + Task 2 Step 4's `if (row.error)`; freshness via rebuild-before-popup ✓ Task 2 Step 5; no new IPC ✓ (chatopsServers called directly, no `window.bean.*`); no right-click ✓ (untouched, still left-click only).
- **Placeholder scan:** none — all code blocks are complete and copy-pasteable.
- **Type consistency:** `ChatopsMenuRow.bot`/`label`/`dot`/`checked`/`error` used identically across Task 1's implementation, its tests, and Task 2's consumption (`row.dot`, `row.label`, `row.checked`, `row.error`, `row.bot`). `chatopsServers?.start(row.bot)`/`stop(row.bot)` match `createChatopsServers`'s existing `start(bot: ChatopsBot)`/`stop(bot: ChatopsBot)` signatures (`chatops-servers.ts:42,63`, unmodified).
