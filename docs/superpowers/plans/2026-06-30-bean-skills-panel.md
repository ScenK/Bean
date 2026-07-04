# SP4 Skills Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Bean's placeholder Skills panel into a browse/view/run/edit surface over `~/.bean/skills/*.md` — a two-pane list+detail view with a `Run skill` action that drops a pending proposal into Chat, and an `Edit .md` action with an in-panel textarea editor.

**Architecture:** `@bean/core` gains a `saveSkill` write function alongside the existing `loadSkills` read. Three new read/write IPC endpoints (`listSkills`, `listProjects`, `saveSkill`) expose skill/project data to the renderer, which had none before. `SkillsPanel` becomes stateful (fetch on mount, view/edit modes) and reuses the existing `ProposalCard`/`confirmProposal` flow from SP2 for running a skill — no new run path.

**Tech Stack:** TypeScript (ESM), `@bean/core` (tsc, pure), `@bean/app` (Electron, esbuild, Preact), Vitest.

**Spec:** [docs/superpowers/specs/2026-06-30-bean-skills-panel-design.md](../specs/2026-06-30-bean-skills-panel-design.md)

## Global Constraints

- `@bean/core` stays pure and Electron-free, dependency-injected — new IO goes there, not in `app/` (`.memory/convention-core-is-electron-free.md`).
- IPC channel names live only in `packages/app/src/channels.ts`, referenced via `IPC.*` (`.memory/convention-ipc-channels.md`). New channels this plan adds: `listSkills`, `listProjects`, `saveSkill`.
- Electron preload stays CommonJS `.cjs` — this plan only adds plain functions to the existing `contextBridge.exposeInMainWorld` call in `preload.ts`, no new syntax risk (`.memory/safety-preload-must-be-cjs.md`).
- ESM everywhere: `.js` extensions in relative imports; `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` + `noUncheckedIndexedAccess` are on — array access is `T | undefined`; handle it.
- No new test-framework dependency. Pure logic (`saveSkill`, IPC handler builders) is unit-tested with Vitest + injected fakes; renderer UI is verified manually via `pnpm dev`.
- **Run skill** sends a pending proposal into the existing Chat panel (reusing `ProposalCard`/`confirmProposal` from SP2) — no new run path, **no change** to `runOpencode`, `packages/core/src/runner.ts`, or the `bean:run` IPC.
- Project resolution for Run skill: first project whose `defaultSkill === skill.name`, else `projects[0]`; the button is disabled if no projects are loaded.
- **Edit .md** is an in-panel textarea editor with Save/Cancel — no shell-out to an OS default editor.
- Save failures show an inline error under the editor and **keep** the user's draft — never silently discard edits.
- Requires Node ≥24, pnpm 11, `opencode` on `PATH`.
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0.

---

### Task 1: Core `saveSkill` (`@bean/core`)

**Files:**
- Modify: `packages/core/src/skill-library.ts`
- Test: `packages/core/__test__/skill-library.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (later tasks rely on this exact name/type): `function saveSkill(dir: string, name: string, body: string): Promise<void>` — re-exported automatically via the existing `packages/core/src/index.ts:3` (`export * from "./skill-library.js";`), no index.ts change needed.

- [x] **Step 1: Write the failing tests**

In `packages/core/__test__/skill-library.test.ts`, change the top import line from:
```typescript
import { mkdtemp, writeFile, rm } from "node:fs/promises";
```
to:
```typescript
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
```
And change:
```typescript
import { loadSkills } from "../src/skill-library.js";
```
to:
```typescript
import { loadSkills, saveSkill } from "../src/skill-library.js";
```

Then append these tests at the end of the file:
```typescript
test("saveSkill writes the file with the given body", async () => {
  await saveSkill(dir, "new-skill", "# New skill\nbody text");
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("new-skill");
  expect(skills[0]!.body).toBe("# New skill\nbody text");
});

test("saveSkill creates the skills directory if missing", async () => {
  const missing = join(dir, "nested");
  await saveSkill(missing, "review-code", "body");
  const skills = await loadSkills(missing);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("review-code");
});

test("saveSkill overwrites existing content", async () => {
  await writeFile(join(dir, "review-code.md"), "old body");
  await saveSkill(dir, "review-code", "new body");
  const raw = await readFile(join(dir, "review-code.md"), "utf8");
  expect(raw).toBe("new body");
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/skill-library.test.ts
```
Expected: FAIL — `saveSkill` is not exported from `../src/skill-library.js` (import/type error).

- [x] **Step 3: Implement `saveSkill`**

In `packages/core/src/skill-library.ts`, change the top import line from:
```typescript
import { readdir, readFile } from "node:fs/promises";
```
to:
```typescript
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
```

Then append at the end of the file:
```typescript
export async function saveSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/skill-library.test.ts
```
Expected: PASS — 6 tests green (3 existing + 3 new).

- [x] **Step 5: Typecheck core**

Run:
```bash
pnpm --filter @bean/core exec tsc -p tsconfig.json --noEmit
```
Expected: exit 0, no errors.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/skill-library.ts packages/core/__test__/skill-library.test.ts
git commit -m "feat(core): add saveSkill for writing skill .md files"
```

---

### Task 2: IPC surface + preload + main wiring (`@bean/app`)

This task adds the full read/write plumbing stack in one pass (channels → IPC handlers → preload → renderer types → main.ts wiring) so the app package typechecks and builds cleanly at the end of the task — splitting it further would leave `RegisterDeps.saveSkill` required but unsatisfied by `main.ts` mid-plan.

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Modify: `packages/app/src/main.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `saveSkill` from `@bean/core` (Task 1); existing `RouteHandlerDeps` (`loadSkills`, `loadProjects`, `skillsDir`, `projectsFile`) already on `ipc.ts`.
- Produces (later tasks rely on these): `window.bean.listSkills(): Promise<Skill[]>`, `window.bean.listProjects(): Promise<Project[]>`, `window.bean.saveSkill(name: string, body: string): Promise<void>`.

- [x] **Step 1: Write the failing IPC handler tests**

In `packages/app/__test__/ipc.test.ts`, change the top import line from:
```typescript
import { buildRouteHandler, buildThemeHandlers, buildChatHandler } from "../src/ipc.js";
```
to:
```typescript
import {
  buildRouteHandler, buildThemeHandlers, buildChatHandler,
  buildListSkillsHandler, buildListProjectsHandler, buildSaveSkillHandler,
} from "../src/ipc.js";
```

Then append these tests at the end of the file:
```typescript
test("listSkills handler loads skills from the configured skills dir", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const handler = buildListSkillsHandler({
    loadSkills: async (dir) => { expect(dir).toBe("/b/skills"); return skills; },
    skillsDir: "/b/skills",
  });
  expect(await handler()).toBe(skills);
});

test("listProjects handler loads projects from the configured projects file", async () => {
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  const handler = buildListProjectsHandler({
    loadProjects: async (file) => { expect(file).toBe("/b/projects.json"); return projects; },
    projectsFile: "/b/projects.json",
  });
  expect(await handler()).toBe(projects);
});

test("saveSkill handler writes through the injected deps with the configured skills dir", async () => {
  const saveSkill = vi.fn(async () => {});
  const handler = buildSaveSkillHandler({ saveSkill, skillsDir: "/b/skills" });
  await handler("review-code", "new body");
  expect(saveSkill).toHaveBeenCalledWith("/b/skills", "review-code", "new body");
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts
```
Expected: FAIL — `buildListSkillsHandler` (and siblings) are not exported from `../src/ipc.js`.

- [x] **Step 3: Add the IPC channels**

In `packages/app/src/channels.ts`, change:
```typescript
export const IPC = {
  route: "bean:route",
  run: "bean:run",
  chat: "bean:chat",
  runEvent: "bean:run-event",
```
to:
```typescript
export const IPC = {
  route: "bean:route",
  run: "bean:run",
  chat: "bean:chat",
  listSkills: "bean:list-skills",
  listProjects: "bean:list-projects",
  saveSkill: "bean:save-skill",
  runEvent: "bean:run-event",
```

- [x] **Step 4: Add the handler builders and wire them into `registerIpc`**

In `packages/app/src/ipc.ts`, after the existing `buildChatHandler` function (currently lines 40-48), insert:
```typescript
export interface ListSkillsHandlerDeps {
  loadSkills: (dir: string) => Promise<Skill[]>;
  skillsDir: string;
}

export function buildListSkillsHandler(deps: ListSkillsHandlerDeps) {
  return (): Promise<Skill[]> => deps.loadSkills(deps.skillsDir);
}

export interface ListProjectsHandlerDeps {
  loadProjects: (file: string) => Promise<Project[]>;
  projectsFile: string;
}

export function buildListProjectsHandler(deps: ListProjectsHandlerDeps) {
  return (): Promise<Project[]> => deps.loadProjects(deps.projectsFile);
}

export interface SaveSkillHandlerDeps {
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  skillsDir: string;
}

export function buildSaveSkillHandler(deps: SaveSkillHandlerDeps) {
  return (name: string, body: string): Promise<void> => deps.saveSkill(deps.skillsDir, name, body);
}
```

Then change the `RegisterDeps` interface from:
```typescript
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  sender: () => WebContents | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  openDashboard: (droppedUrl?: string) => void;
}
```
to:
```typescript
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  sender: () => WebContents | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  openDashboard: (droppedUrl?: string) => void;
}
```

Then in `registerIpc`, change:
```typescript
  const chatHandler = buildChatHandler(deps);
  ipcMain.handle(IPC.chat, (_e, req: ChatRequest) => chatHandler(req));

  const theme = buildThemeHandlers(deps);
```
to:
```typescript
  const chatHandler = buildChatHandler(deps);
  ipcMain.handle(IPC.chat, (_e, req: ChatRequest) => chatHandler(req));

  const listSkillsHandler = buildListSkillsHandler(deps);
  ipcMain.handle(IPC.listSkills, () => listSkillsHandler());

  const listProjectsHandler = buildListProjectsHandler(deps);
  ipcMain.handle(IPC.listProjects, () => listProjectsHandler());

  const saveSkillHandler = buildSaveSkillHandler(deps);
  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => saveSkillHandler(name, body));

  const theme = buildThemeHandlers(deps);
```

- [x] **Step 5: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts
```
Expected: PASS — 6 tests green (3 existing + 3 new).

- [x] **Step 6: Expose the new calls in `preload.ts`**

In `packages/app/src/preload.ts`, change the type import from:
```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult } from "@bean/core";
```
to:
```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project } from "@bean/core";
```

Then add these three entries to the `contextBridge.exposeInMainWorld("bean", { ... })` object, after `onDashboardDroppedUrl`:
```typescript
  listSkills: (): Promise<Skill[]> => ipcRenderer.invoke(IPC.listSkills),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.listProjects),
  saveSkill: (name: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.saveSkill, name, body),
```

- [x] **Step 7: Add the types to `bean.d.ts`**

In `packages/app/src/renderer/bean.d.ts`, change the type import from:
```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult } from "@bean/core";
```
to:
```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project } from "@bean/core";
```

Then add these three lines to the `Window.bean` interface, after `onDashboardDroppedUrl(cb: (url: string) => void): void;`:
```typescript
      listSkills(): Promise<Skill[]>;
      listProjects(): Promise<Project[]>;
      saveSkill(name: string, body: string): Promise<void>;
```

- [x] **Step 8: Wire the real `saveSkill` into `main.ts`**

In `packages/app/src/main.ts`, change the `@bean/core` import from:
```typescript
import {
  beanDir, configFile, projectsFile, skillsDir,
  loadConfig, loadSkills, loadProjects, makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
```
to:
```typescript
import {
  beanDir, configFile, projectsFile, skillsDir,
  loadConfig, loadSkills, loadProjects, saveSkill, makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
```

Then change the `registerIpc(ipcMain, { ... })` call from:
```typescript
    registerIpc(ipcMain, {
      loadSkills, loadProjects,
      chat: makeOpenAIChat(cfg.openaiApiKey),
```
to:
```typescript
    registerIpc(ipcMain, {
      loadSkills, loadProjects, saveSkill,
      chat: makeOpenAIChat(cfg.openaiApiKey),
```

- [x] **Step 9: Typecheck + build the app**

Run:
```bash
pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit && pnpm --filter @bean/app build
```
Expected: exit 0.

- [x] **Step 10: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/main.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): add listSkills/listProjects/saveSkill IPC surface"
```

---

### Task 3: `SkillsPanel` component + styling (`@bean/app`)

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx` (replace the placeholder)
- Modify: `packages/app/src/renderer/dashboard.css`

**Interfaces:**
- Consumes: `window.bean.listSkills`/`listProjects`/`saveSkill` (Task 2); `Skill`/`Project`/`RouteSuggestion` types from `@bean/core`.
- Produces: `SkillsPanel` accepting an **optional** prop `{ onRunSkill?: (run: RouteSuggestion) => void }` (defaulting to a no-op) — kept optional so `<SkillsPanel />` (App's current call, unchanged in this task) still typechecks until Task 4 wires the real handler.

- [x] **Step 1: Replace `SkillsPanel.tsx`**

Overwrite `packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx`:
```tsx
import { useEffect, useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import type { Project, RouteSuggestion, Skill } from "@bean/core";

type Mode = "view" | "edit";

export function SkillsPanel({
  onRunSkill = () => {},
}: {
  onRunSkill?: (run: RouteSuggestion) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedName, setSelectedName] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const [nextSkills, nextProjects] = await Promise.all([
      window.bean.listSkills(),
      window.bean.listProjects(),
    ]);
    setSkills(nextSkills);
    setProjects(nextProjects);
    setSelectedName((prev) => prev ?? nextSkills[0]?.name);
  };

  useEffect(() => { void refresh(); }, []);

  const selected = skills.find((s) => s.name === selectedName);

  const selectSkill = (name: string): void => {
    setSelectedName(name);
    setMode("view");
    setSaveError(undefined);
  };

  const startEdit = (): void => {
    if (!selected) return;
    setDraft(selected.body);
    setSaveError(undefined);
    setMode("edit");
  };

  const cancelEdit = (): void => {
    setMode("view");
    setSaveError(undefined);
  };

  const save = async (): Promise<void> => {
    if (!selected) return;
    try {
      await window.bean.saveSkill(selected.name, draft);
      await refresh();
      setMode("view");
      setSaveError(undefined);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const runSkill = (): void => {
    if (!selected || projects.length === 0) return;
    const project = projects.find((p) => p.defaultSkill === selected.name) ?? projects[0]!;
    onRunSkill({ skillName: selected.name, projectPath: project.path, composedPrompt: "", confidence: 1 });
  };

  if (skills.length === 0) {
    return (
      <div class="bean-panel">
        <PanelHeader title="Skills" />
        <div class="bean-panel-empty">No skills found — add markdown files under ~/.bean/skills/*.md</div>
      </div>
    );
  }

  return (
    <div class="bean-panel">
      <PanelHeader title="Skills" />
      <div class="bean-skills">
        <div class="bean-skills-list">
          {skills.map((s) => (
            <div
              key={s.name}
              class={`bean-skills-row${s.name === selectedName ? " bean-skills-row--selected" : ""}`}
              onClick={() => selectSkill(s.name)}
            >
              {s.name}
            </div>
          ))}
          <span class="bean-skills-spacer" />
          <div class="bean-skills-path">~/.bean/skills/*.md</div>
        </div>
        <div class="bean-skills-detail">
          {selected && mode === "view" ? (
            <>
              <div class="bean-skills-title">{selected.name}</div>
              <div class="bean-skills-description">{selected.description}</div>
              <div class="bean-skills-preview">{selected.body.split("\n").slice(0, 2).join("\n")}</div>
              <span class="bean-skills-spacer" />
              <div class="bean-card-actions">
                <button
                  type="button"
                  class="bean-btn"
                  disabled={projects.length === 0}
                  title={projects.length === 0 ? "No projects configured" : undefined}
                  onClick={runSkill}
                >
                  Run skill
                </button>
                <button type="button" class="bean-btn bean-btn--ghost" onClick={startEdit}>
                  Edit .md
                </button>
              </div>
            </>
          ) : null}
          {selected && mode === "edit" ? (
            <>
              <textarea
                class="bean-skills-editor"
                value={draft}
                onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              />
              {saveError ? <div class="bean-skills-error">Save failed: {saveError}</div> : null}
              <div class="bean-card-actions">
                <button type="button" class="bean-btn" onClick={() => void save()}>Save</button>
                <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelEdit}>Cancel</button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 2: Append skills panel styles**

Append to the end of `packages/app/src/renderer/dashboard.css`:
```css
/* --- skills (SP4) --- */
.bean-skills {
  display: flex;
  flex: 1;
  min-height: 0;
}
.bean-skills-list {
  width: 42%;
  border-right: 1px solid var(--bean-border);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
}
.bean-skills-row {
  font-size: 13px;
  color: var(--bean-text);
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.bean-skills-row--selected {
  color: var(--bean-accent-ink);
  background: var(--bean-accent);
  font-weight: 600;
}
.bean-skills-spacer { flex: 1; }
.bean-skills-path {
  font: 600 11px ui-monospace, monospace;
  color: var(--bean-text-dim);
  padding: 8px 10px;
}
.bean-skills-detail {
  flex: 1;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.bean-skills-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--bean-text);
}
.bean-skills-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--bean-text-dim);
}
.bean-skills-preview {
  font: 12px/1.6 ui-monospace, monospace;
  color: var(--bean-text-dim);
  background: var(--bean-surface-2);
  border: 1px solid var(--bean-border);
  border-radius: 9px;
  padding: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bean-skills-editor {
  flex: 1;
  min-height: 140px;
  resize: vertical;
  font: 12px/1.5 ui-monospace, monospace;
  color: var(--bean-text);
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 8px;
  padding: 9px 11px;
  box-sizing: border-box;
}
.bean-skills-error {
  font-size: 12px;
  color: #e5484d;
}
```

- [x] **Step 3: Typecheck + build the app**

Run:
```bash
pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit && pnpm --filter @bean/app build
```
Expected: exit 0. `SkillsPanel`'s `onRunSkill` prop is optional, so App's existing `<SkillsPanel />` call (unchanged in this task) still typechecks.

- [x] **Step 4: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx packages/app/src/renderer/dashboard.css
git commit -m "feat(app): build SkillsPanel browse/run/edit view"
```

---

### Task 4: Wire `Run skill` into Chat + full validation + manual verification + ledger update

**Files:**
- Modify: `packages/app/src/renderer/dashboard/App.tsx`
- Modify: `docs/superpowers/bean-redesign-playbook.md` (status ledger row for SP4)
- Modify: `.memory/project-dashboard-redesign-roadmap.md` (status line)
- Check off completed step boxes in this plan file and in Tasks 1-3 above.

**Interfaces:**
- Consumes: `SkillsPanel`'s `onRunSkill` prop (Task 3); existing `ChatItem`/`newId`/`setItems` from `App.tsx`.
- Produces: nothing downstream (terminal task in this plan).

- [x] **Step 1: Add the run-skill handler and wire it to `SkillsPanel`**

In `packages/app/src/renderer/dashboard/App.tsx`, after the existing `cancelProposal` function (currently lines 102-104):
```typescript
  const cancelProposal = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "cancelled" } : it)));
  };
```
insert:
```typescript

  const runSkillProposal = (run: RouteSuggestion): void => {
    setItems((prev) => [...prev, { kind: "proposal", id: newId(), run, state: "pending" }]);
  };
```

Then replace `<SkillsPanel />` (currently line 113) with:
```tsx
        <SkillsPanel onRunSkill={runSkillProposal} />
```

- [x] **Step 2: Typecheck + build the app**

Run:
```bash
pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit && pnpm --filter @bean/app build
```
Expected: exit 0.

- [x] **Step 3: Commit**

```bash
git add packages/app/src/renderer/dashboard/App.tsx
git commit -m "feat(app): wire Run skill into the chat proposal flow"
```

- [x] **Step 4: Run the full repo gate**

Run:
```bash
pnpm test && pnpm typecheck
```
Expected: both turbo tasks succeed, exit 0. (`@bean/core` includes the 3 new `saveSkill` tests; `@bean/app` includes the 3 new IPC handler tests; both packages' `tsc --noEmit` clean.)

- [ ] **Step 5: Manual walkthrough via `pnpm dev`**

Requires `~/.bean/config.json` with a real `openaiApiKey`, at least two skills under `~/.bean/skills/*.md`, and at least one entry in `~/.bean/projects.json` with a real `path`. Run:
```bash
pnpm dev
```
Verify each, checking the box only after observing it:
- [ ] The Skills panel lists all skills from `~/.bean/skills/*.md`; the first is selected by default with its name, description, and preview shown.
- [ ] Clicking a different skill updates the detail pane; if mid-edit, the edit is abandoned and the view reverts to the newly selected skill.
- [ ] Clicking `Run skill` on a skill whose owning project has `defaultSkill` set to it appends a pending proposal card to the Chat panel with the expected `skillName`/`projectPath` and an empty, editable prompt.
- [ ] Confirming that proposal runs exactly like a chat-originated one (streams into the Console panel per SP3).
- [ ] Clicking `Run skill` on a skill with no matching `defaultSkill` project uses `projects[0]` instead.
- [ ] With `~/.bean/projects.json` emptied/renamed away → `Run skill` is disabled (and the console/chat still work otherwise).
- [ ] Clicking `Edit .md`, changing the body, and clicking `Save` updates the file on disk (check with `cat`) and returns to view mode showing the new description/preview.
- [ ] Clicking `Edit .md`, changing the body, and clicking `Cancel` leaves the file on disk unchanged.
- [ ] Forcing a save failure (e.g. `chmod 444` on a skill file before saving) shows an inline "Save failed: …" error and **keeps** the edited draft in the textarea; a retry after restoring permissions succeeds.
- [ ] With `~/.bean/skills/` emptied/renamed away → the panel shows its empty state instead of an empty list.
- [ ] Toggling Hearth/Graphite (title-bar button) restyles the Skills panel like other panels.

> If your environment cannot exercise interactive GUI clicks (no screenshot/automation tool), note that explicitly and confirm via the Task 1-3 unit tests plus a static code review of `SkillsPanel.tsx` against this checklist instead — same substitution SP3's manual step used.

> **Actual (builder session, left unchecked above — not observed):** the runtime setup was real
> (`~/.bean/config.json` has a live `openaiApiKey`, `~/.bean/skills/*.md` has two skills
> (`console-qa.md`, `echo.md`), `~/.bean/projects.json` lists two real project paths), so
> `pnpm dev` was launched and produced a clean multi-process Electron start (main/gpu/renderer/
> network, confirmed via `ps aux`) with no crash — indirect confirmation the Task 4 wiring
> doesn't throw at runtime (a broken `onRunSkill` wiring would have thrown the instant
> `SkillsPanel` rendered or `runSkillProposal` was invoked). Beyond that, this agent session has
> **no GUI-automation or screenshot tool** to click skill rows, click `Run skill`/`Edit .md`,
> type into the editor, or read the Chat/Console panels' rendered state, so none of the
> interactive checklist items above could be *observed* and are left unchecked rather than
> guessed. Substituted verification: (1) the full Task 1-3 test suite (9 `saveSkill`/IPC-handler
> tests plus the pre-existing suite) passed in Step 4's gate; (2) static review of
> `App.tsx`'s new `runSkillProposal` (line 106-108) confirms it appends
> `{ kind: "proposal", id: newId(), run, state: "pending" }` — the exact same `ChatItem`
> `"proposal"` shape `sendMessage` (line 89) and `confirmProposal`/`cancelProposal` already
> handle for a chat-originated proposal, so `ProposalCard`'s render/confirm/cancel logic is
> reused verbatim with zero new branching; (3) static review of `SkillsPanel.tsx`'s `runSkill`
> (lines 63-67) confirms it resolves `projects.find((p) => p.defaultSkill === selected.name) ??
> projects[0]!` and calls `onRunSkill({ skillName, projectPath, composedPrompt: "", confidence: 1
> })` — matching `RouteSuggestion`'s shape exactly, with `onRunSkill={runSkillProposal}` now
> passed from `App.tsx` (line 116) instead of the Task 3 no-op default. A human (or an agent with
> display/automation access) still needs to run the interactive checklist before this is fully
> signed off.

- [x] **Step 6: Update the status ledger**

In `docs/superpowers/bean-redesign-playbook.md`, change the SP4 row to reference the spec/plan and mark it done:
```markdown
| 4 | Skills panel: browse / view / run / edit `~/.bean/skills/*.md`; needs new read-oriented IPC | `specs/2026-06-30-bean-skills-panel-design.md` | `plans/2026-06-30-bean-skills-panel.md` | ✅ done + reviewed |
```

- [x] **Step 7: Update the roadmap memory**

In `.memory/project-dashboard-redesign-roadmap.md`, update the "Status at last update" text to reflect SP4 complete (SP1-4 done; SP5-6 not started), noting SP4 added the `listSkills`/`listProjects`/`saveSkill` IPC endpoints and that `Run skill` reuses SP2's `ProposalCard`/`confirmProposal` flow with no new run path.

- [x] **Step 8: Check off this plan's step boxes**

Mark every completed `- [ ]` in this plan file as `- [x]`.

- [x] **Step 9: Commit**

```bash
git add docs/superpowers/bean-redesign-playbook.md .memory/project-dashboard-redesign-roadmap.md docs/superpowers/plans/2026-06-30-bean-skills-panel.md
git commit -m "docs(sp4): mark skills panel done and update ledger"
```

---

## Self-Review

**Spec coverage:**
- §4.1 core `saveSkill` (mkdir + writeFile) → Task 1.
- §4.2 IPC channels + handler builders (`listSkills`/`listProjects`/`saveSkill`) + `RegisterDeps` → Task 2.
- §4.2 preload/`bean.d.ts` exposure + `main.ts` wiring → Task 2.
- §4.3 `SkillsPanel` (fetch on mount, list, view/edit modes, Run skill resolution, Save/Cancel, error handling, empty state) → Task 3.
- §4.4 `App` wiring (`onRunSkill` → proposal `ChatItem`) → Task 4.
- §4.5 CSS (two-pane layout, row selection, editor) → Task 3.
- §5 error handling (empty lists, save failure inline + draft retained) → Task 3 (implementation) and Task 4's manual checklist (verification).
- §6 tests (core `saveSkill`, IPC handler builders) → Task 1 and Task 2; renderer manual → Task 4.
- §7 manual checklist → Task 4 Step 5 (every bullet from the spec's checklist is reproduced).
- "No change to runner/IPC run path" → Global Constraints; no task touches `runner.ts` or `IPC.run`.

**Placeholder scan:** none — every code step shows full file content or precise before/after context; commands and expected outputs are concrete.

**Type consistency:** `saveSkill(dir, name, body): Promise<void>` signature identical across Task 1 (core), Task 2 (`SaveSkillHandlerDeps`, `preload.ts`, `bean.d.ts`, `main.ts`), and Task 3 (`window.bean.saveSkill` call). `listSkills`/`listProjects` return `Skill[]`/`Project[]` consistently across Task 2's handler builders, `preload.ts`, `bean.d.ts`, and Task 3's `SkillsPanel`. `SkillsPanel`'s `onRunSkill?: (run: RouteSuggestion) => void` prop (Task 3) matches the `runSkillProposal` handler's parameter type and the `ChatItem` `"proposal"` variant's `run: ProposedRun` field (`ProposedRun` is a type alias for `RouteSuggestion` per `converse.ts:16`) used in Task 4.
