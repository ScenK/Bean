# SP5 Persona Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Bean's placeholder Persona panel into an editable name + tone-tags surface, and lift the frozen `DEFAULT_SYSTEM_PROMPT` string out of `converse.ts` into a real `Persona` that persists to `~/.bean/persona.json` and drives the system prompt sent to the model.

**Architecture:** `@bean/core` gains a pure, zero-Node-import `persona.ts` (types, the six-tag preset, `DEFAULT_PERSONA`, validation, and `composePersonaPrompt`) exposed via a new `@bean/core/persona` subpath — mirroring the `@bean/core/terminal` split SP3 introduced, because the renderer needs `PERSONA_TAGS` as a runtime value and cannot pull Node-only modules into its browser esbuild bundle. A separate `persona-store.ts` holds the Node-only `loadPersona`/`savePersona`. `converse()` takes a required `persona` parameter and composes its system prompt from `composePersonaPrompt(persona)` plus a fixed behavior-instructions constant. Two new IPC endpoints (`getPersona`, `savePersona`) expose read/write to the renderer; `PersonaPanel` becomes stateful (fetch on mount, view/edit modes) matching `SkillsPanel`'s pattern.

**Tech Stack:** TypeScript (ESM), `@bean/core` (tsc, pure), `@bean/app` (Electron, esbuild, Preact), Vitest.

**Spec:** [docs/superpowers/specs/2026-06-30-bean-persona-panel-design.md](../specs/2026-06-30-bean-persona-panel-design.md)

## Global Constraints

- `@bean/core` stays pure and Electron-free, dependency-injected — new IO goes there, not in `app/` (`.memory/convention-core-is-electron-free.md`).
- IPC channel names live only in `packages/app/src/channels.ts`, referenced via `IPC.*` (`.memory/convention-ipc-channels.md`). New channels this plan adds: `getPersona`, `savePersona`.
- Electron preload stays CommonJS `.cjs` — this plan only adds plain functions to the existing `contextBridge.exposeInMainWorld` call in `preload.ts`, no new syntax risk (`.memory/safety-preload-must-be-cjs.md`).
- ESM everywhere: `.js` extensions in relative imports; `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` + `noUncheckedIndexedAccess` are on — array access is `T | undefined`; handle it.
- **Browser-bundle safety:** anything the renderer imports as a runtime *value* (not just a type) from `@bean/core` must come from a subpath whose module has zero transitive `node:*` imports — never the main `@bean/core` barrel. This plan's `persona.ts` follows the exact pattern `terminal.ts` established in SP3 (own file, own `package.json` subpath, no Node imports).
- No new test-framework dependency. Pure logic (`persona.ts`, `persona-store.ts`, `converse.ts`, IPC handler builders) is unit-tested with Vitest + injected fakes; renderer UI is verified manually via `pnpm dev`.
- Persona name only affects the system prompt (`You are {name}...`) — **do not** touch the title bar, chat placeholder, or command-bar placeholder strings; those stay static "Bean" UI chrome (out of scope per the spec).
- Tone input is the fixed six-tag preset (`Warm`, `Concise`, `Direct`, `Playful`, `Formal`, `Encouraging`) — no free-text tone field, no raw-system-prompt override.
- The sample-voice line in view mode is a fixed, hardcoded string — it does not change with the selected tags.
- `converse()`'s signature change (adding `persona`) is a breaking change to every call site in this codebase — update them all in the same change, don't add an optional/back-compat parameter.
- Requires Node ≥24, pnpm 11, `opencode` on `PATH`.
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0.

---

### Task 1: Core `persona.ts` + `persona-store.ts` + `personaFile` (`@bean/core`)

**Files:**
- Create: `packages/core/src/persona.ts`
- Create: `packages/core/src/persona-store.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json`
- Create: `packages/core/__test__/persona-store.test.ts`
- Modify: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (later tasks rely on these exact names/types):
  - `packages/core/src/persona.ts`: `PERSONA_TAGS: readonly ["Warm", "Concise", "Direct", "Playful", "Formal", "Encouraging"]`, `type PersonaTag`, `interface Persona { name: string; tags: PersonaTag[] }`, `DEFAULT_PERSONA: Persona`, `function isValidPersona(v: unknown): v is Persona`, `function composePersonaPrompt(persona: Persona): string`.
  - `packages/core/src/persona-store.ts`: `function loadPersona(file: string): Promise<Persona>`, `function savePersona(file: string, persona: Persona): Promise<void>`.
  - `packages/core/src/config.ts`: `function personaFile(dir: string): string`.
  - New `@bean/core/persona` subpath resolving to `dist/persona.js` (for the renderer, Task 4).
  - `loadPersona`/`savePersona`/`personaFile`/everything from `persona.ts` re-exported from the main `@bean/core` barrel (for `ipc.ts`/`main.ts`, Tasks 2–3).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__test__/persona-store.test.ts`:
```typescript
import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersona, savePersona } from "../src/persona-store.js";
import { DEFAULT_PERSONA, type Persona, type PersonaTag } from "../src/persona.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-persona-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("missing file returns the default persona", async () => {
  expect(await loadPersona(join(dir, "persona.json"))).toEqual(DEFAULT_PERSONA);
});

test("invalid JSON returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, "{ not json");
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("an empty name fails validation and returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, JSON.stringify({ name: "  ", tags: ["Warm"] }));
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("an empty tags array fails validation and returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, JSON.stringify({ name: "Bean", tags: [] }));
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("an unknown tag value fails validation and returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, JSON.stringify({ name: "Bean", tags: ["Sarcastic"] }));
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("save then load round-trips", async () => {
  const file = join(dir, "nested", "persona.json");
  const persona: Persona = { name: "Buddy", tags: ["Playful", "Warm"] };
  await savePersona(file, persona);
  expect(await loadPersona(file)).toEqual(persona);
});

test("savePersona creates the parent directory if missing", async () => {
  const file = join(dir, "nested", "persona.json");
  await savePersona(file, DEFAULT_PERSONA);
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("savePersona rejects an empty/whitespace-only name", async () => {
  await expect(savePersona(join(dir, "persona.json"), { name: "   ", tags: ["Warm"] })).rejects.toThrow();
});

test("savePersona rejects an empty tags array", async () => {
  await expect(savePersona(join(dir, "persona.json"), { name: "Bean", tags: [] })).rejects.toThrow();
});

test("savePersona rejects a tag not in PERSONA_TAGS", async () => {
  const bad = { name: "Bean", tags: ["Sarcastic" as PersonaTag] };
  await expect(savePersona(join(dir, "persona.json"), bad)).rejects.toThrow();
});
```

In `packages/core/__test__/config.test.ts`, change:
```typescript
import { loadConfig, skillsDir, projectsFile, configFile } from "../src/config.js";
```
to:
```typescript
import { loadConfig, skillsDir, projectsFile, configFile, personaFile } from "../src/config.js";
```
and change:
```typescript
test("path helpers", () => {
  expect(skillsDir("/b")).toBe("/b/skills");
  expect(projectsFile("/b")).toBe("/b/projects.json");
  expect(configFile("/b")).toBe("/b/config.json");
});
```
to:
```typescript
test("path helpers", () => {
  expect(skillsDir("/b")).toBe("/b/skills");
  expect(projectsFile("/b")).toBe("/b/projects.json");
  expect(configFile("/b")).toBe("/b/config.json");
  expect(personaFile("/b")).toBe("/b/persona.json");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/persona-store.test.ts __test__/config.test.ts
```
Expected: FAIL — `../src/persona-store.js` and `../src/persona.js` do not exist yet, and `personaFile` is not exported from `config.js`.

- [ ] **Step 3: Create `persona.ts`**

Create `packages/core/src/persona.ts`:
```typescript
export const PERSONA_TAGS = ["Warm", "Concise", "Direct", "Playful", "Formal", "Encouraging"] as const;
export type PersonaTag = typeof PERSONA_TAGS[number];

export interface Persona {
  name: string;
  tags: PersonaTag[];
}

export const DEFAULT_PERSONA: Persona = { name: "Bean", tags: ["Warm", "Concise", "Direct"] };

export function isValidPersona(v: unknown): v is Persona {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim() === "") return false;
  if (!Array.isArray(p.tags) || p.tags.length === 0) return false;
  return p.tags.every((t) => (PERSONA_TAGS as readonly string[]).includes(t as PersonaTag));
}

export function composePersonaPrompt(persona: Persona): string {
  const tags = persona.tags.map((t) => t.toLowerCase()).join(", ");
  return `You are ${persona.name}, a ${tags} desktop coding companion. Reply in a way that reflects that.`;
}
```

- [ ] **Step 4: Create `persona-store.ts`**

Create `packages/core/src/persona-store.ts`:
```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PERSONA, isValidPersona, type Persona } from "./persona.js";

export async function loadPersona(file: string): Promise<Persona> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return isValidPersona(parsed) ? parsed : DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
}

export async function savePersona(file: string, persona: Persona): Promise<void> {
  if (!isValidPersona(persona)) throw new Error("invalid persona: name and at least one tag are required");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(persona, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 5: Add `personaFile` to `config.ts`**

In `packages/core/src/config.ts`, change:
```typescript
export function skillsDir(dir: string): string { return join(dir, "skills"); }
export function projectsFile(dir: string): string { return join(dir, "projects.json"); }
export function configFile(dir: string): string { return join(dir, "config.json"); }
```
to:
```typescript
export function skillsDir(dir: string): string { return join(dir, "skills"); }
export function projectsFile(dir: string): string { return join(dir, "projects.json"); }
export function configFile(dir: string): string { return join(dir, "config.json"); }
export function personaFile(dir: string): string { return join(dir, "persona.json"); }
```

- [ ] **Step 6: Add the `@bean/core/persona` subpath export**

In `packages/core/package.json`, change:
```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./terminal": {
      "types": "./dist/terminal.d.ts",
      "default": "./dist/terminal.js"
    }
  },
```
to:
```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./terminal": {
      "types": "./dist/terminal.d.ts",
      "default": "./dist/terminal.js"
    },
    "./persona": {
      "types": "./dist/persona.d.ts",
      "default": "./dist/persona.js"
    }
  },
```

- [ ] **Step 7: Re-export from the main barrel**

In `packages/core/src/index.ts`, change:
```typescript
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
export * from "./router.js";
export * from "./converse.js";
export * from "./openai-chat.js";
export * from "./runner.js";
export * from "./terminal.js";
```
to:
```typescript
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
export * from "./persona.js";
export * from "./persona-store.js";
export * from "./router.js";
export * from "./converse.js";
export * from "./openai-chat.js";
export * from "./runner.js";
export * from "./terminal.js";
```

- [ ] **Step 8: Build core and run the tests to verify they pass**

Run:
```bash
pnpm --filter @bean/core build && pnpm --filter @bean/core exec vitest run __test__/persona-store.test.ts __test__/config.test.ts
```
Expected: both files' tests PASS, and `packages/core/dist/persona.js` / `packages/core/dist/persona.d.ts` exist (confirm with `ls packages/core/dist/persona.*`).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/persona.ts packages/core/src/persona-store.ts packages/core/src/config.ts packages/core/src/index.ts packages/core/package.json packages/core/__test__/persona-store.test.ts packages/core/__test__/config.test.ts
git commit -m "feat(core): add Persona type, store, and browser-safe subpath export"
```

---

### Task 2: `converse.ts` prompt lift (`@bean/core`)

**Files:**
- Modify: `packages/core/src/converse.ts`
- Modify: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: `composePersonaPrompt`, `DEFAULT_PERSONA`, `type Persona` from `./persona.js` (Task 1).
- Produces (later tasks rely on this exact signature): `converse(history: ChatTurn[], latestUserText: string, skills: Skill[], projects: Project[], persona: Persona, deps: ConverseDeps, droppedUrl?: string): Promise<ConverseResult>` — note `persona` is now the 5th positional parameter, inserted between `projects` and `deps`.

- [ ] **Step 1: Update the failing tests**

Replace the full contents of `packages/core/__test__/converse.test.ts` with:
```typescript
import { expect, test } from "vitest";
import { converse, type ConverseDeps, type ToolSpec } from "../src/converse.js";
import { composePersonaPrompt, DEFAULT_PERSONA, type Persona } from "../src/persona.js";
import type { Project, Skill } from "../src/types.js";

const skills: Skill[] = [
  { name: "review-code", description: "review a diff", body: "REVIEW BODY" },
  { name: "write-tests", description: "write tests", body: "TESTS BODY" },
];
const projects: Project[] = [
  { name: "api", path: "/work/api", defaultSkill: "review-code" },
  { name: "bean", path: "/dev/bean" },
];

function depsReturning(content: string, toolCalls: { name: string; args: unknown }[] = []): ConverseDeps {
  return { model: "m", chat: async () => ({ content, toolCalls }) };
}

test("plain reply with no tool call yields no proposal", async () => {
  const res = await converse([], "hi there", skills, projects, DEFAULT_PERSONA, depsReturning("Hello!"));
  expect(res.reply).toBe("Hello!");
  expect(res.proposedRun).toBeUndefined();
});

test("valid propose_run tool call composes a run from the local skill body", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "review the 3 PRs" } },
  ]);
  const res = await converse([], "review the PRs in api", skills, projects, DEFAULT_PERSONA, deps, "https://linear/BEAN-42");
  expect(res.reply).toBe("On it.");
  expect(res.proposedRun?.skillName).toBe("review-code");
  expect(res.proposedRun?.projectPath).toBe("/work/api");
  expect(res.proposedRun?.composedPrompt).toContain("REVIEW BODY");
  expect(res.proposedRun?.composedPrompt).toContain("review the 3 PRs");
  expect(res.proposedRun?.composedPrompt).toContain("https://linear/BEAN-42");
});

test("tool call naming an unknown skill or project drops the proposal but keeps the reply", async () => {
  const deps = depsReturning("Hmm.", [
    { name: "propose_run", args: { skill: "nope", project: "/nowhere", instruction: "x" } },
  ]);
  const res = await converse([], "do a thing", skills, projects, DEFAULT_PERSONA, deps);
  expect(res.reply).toBe("Hmm.");
  expect(res.proposedRun).toBeUndefined();
});

test("propose_run tool is enum-constrained to known skill names and project paths", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, deps);
  expect(captured).toHaveLength(1);
  const props = (captured[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.skill?.enum).toEqual(["review-code", "write-tests"]);
  expect(props.project?.enum).toEqual(["/work/api", "/dev/bean"]);
});

test("no propose_run tool is offered when skills or projects are empty", async () => {
  let captured: ToolSpec[] = [{ name: "sentinel", description: "", parameters: {} }];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "hi", toolCalls: [] }; },
  };
  await converse([], "hi", skills, [], DEFAULT_PERSONA, deps);
  expect(captured).toHaveLength(0);
});

test("history turns are accepted and the function never throws on chat failure", async () => {
  const deps: ConverseDeps = { model: "m", chat: async () => { throw new Error("network"); } };
  const res = await converse(
    [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
    "again", skills, projects, DEFAULT_PERSONA, deps,
  );
  expect(res.proposedRun).toBeUndefined();
  expect(res.reply.length).toBeGreaterThan(0);
});

test("system prompt composes persona intro, behavior instructions, and catalog in order", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      systemContent = messages[0]!.content;
      return { content: "ok", toolCalls: [] };
    },
  };
  const persona: Persona = { name: "Ponyta", tags: ["Playful", "Formal"] };
  await converse([], "hi", skills, projects, persona, deps);
  const personaIdx = systemContent.indexOf(composePersonaPrompt(persona));
  const behaviorIdx = systemContent.indexOf("You cannot do work yourself");
  const catalogIdx = systemContent.indexOf("Skills:");
  expect(personaIdx).toBe(0);
  expect(behaviorIdx).toBeGreaterThan(personaIdx);
  expect(catalogIdx).toBeGreaterThan(behaviorIdx);
});

test("composePersonaPrompt reflects the default persona's name and tags", () => {
  expect(composePersonaPrompt(DEFAULT_PERSONA)).toBe(
    "You are Bean, a warm, concise, direct desktop coding companion. Reply in a way that reflects that.",
  );
});

test("composePersonaPrompt reflects a custom persona's name and tags", () => {
  expect(composePersonaPrompt({ name: "Ponyta", tags: ["Playful", "Formal"] })).toBe(
    "You are Ponyta, a playful, formal desktop coding companion. Reply in a way that reflects that.",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/converse.test.ts
```
Expected: FAIL with type/argument errors — `converse()` doesn't yet accept a `persona` argument, and `DEFAULT_SYSTEM_PROMPT` (not `composePersonaPrompt`) is still what `converse.ts` uses.

- [ ] **Step 3: Update `converse.ts`**

In `packages/core/src/converse.ts`, change:
```typescript
import { composePrompt } from "./prompt.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";
```
to:
```typescript
import { composePrompt } from "./prompt.js";
import { composePersonaPrompt, type Persona } from "./persona.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";
```

Change:
```typescript
export const DEFAULT_SYSTEM_PROMPT =
  "You are Bean, a warm, concise desktop coding companion. Reply briefly and directly. " +
  "You cannot do work yourself — a separate `opencode` process does. When the user wants " +
  "a concrete task done in one of their projects, call the propose_run tool with the best " +
  "matching skill name, project path, and a clear instruction; otherwise just reply in text. " +
  "Only propose a run when the user clearly wants work done.";
```
to:
```typescript
const BEHAVIOR_INSTRUCTIONS =
  "You cannot do work yourself — a separate `opencode` process does. When the user wants " +
  "a concrete task done in one of their projects, call the propose_run tool with the best " +
  "matching skill name, project path, and a clear instruction; otherwise just reply in text. " +
  "Only propose a run when the user clearly wants work done.";
```

Change:
```typescript
export async function converse(
  history: ChatTurn[],
  latestUserText: string,
  skills: Skill[],
  projects: Project[],
  deps: ConverseDeps,
  droppedUrl?: string,
): Promise<ConverseResult> {
  const messages: ConvoMsg[] = [
    { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${catalog(skills, projects)}` },
```
to:
```typescript
export async function converse(
  history: ChatTurn[],
  latestUserText: string,
  skills: Skill[],
  projects: Project[],
  persona: Persona,
  deps: ConverseDeps,
  droppedUrl?: string,
): Promise<ConverseResult> {
  const messages: ConvoMsg[] = [
    { role: "system", content: `${composePersonaPrompt(persona)}\n\n${BEHAVIOR_INSTRUCTIONS}\n\n${catalog(skills, projects)}` },
```

Everything else in the file (`ConvoMsg`, `ChatTurn`, `ToolSpec`, `ToolCall`, `ConverseDeps`, `ProposedRun`, `ConverseResult`, `ChatRequest`, `proposeRunTool`, `catalog`, and the rest of `converse`'s body) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/converse.test.ts
```
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): lift DEFAULT_SYSTEM_PROMPT into composePersonaPrompt(persona)"
```

---

### Task 3: IPC surface + preload + main wiring (`@bean/app`)

This task adds the full read/write plumbing stack in one pass (channels → IPC handlers → preload → renderer types → main.ts wiring), same shape as SP4's Task 2 — splitting it further would leave `RegisterDeps` fields required but unsatisfied by `main.ts` mid-plan.

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Modify: `packages/app/src/main.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `loadPersona`, `savePersona`, `personaFile`, `type Persona` from `@bean/core` (Task 1); `converse()`'s new signature (Task 2).
- Produces (later tasks rely on these): `window.bean.getPersona(): Promise<Persona>`, `window.bean.savePersona(p: Persona): Promise<void>`.

- [ ] **Step 1: Write the failing IPC handler tests**

In `packages/app/__test__/ipc.test.ts`, change:
```typescript
import { expect, test, vi } from "vitest";
import {
  buildRouteHandler, buildThemeHandlers, buildChatHandler,
  buildListSkillsHandler, buildListProjectsHandler, buildSaveSkillHandler,
} from "../src/ipc.js";
import type { Project, RouteSuggestion, Skill } from "@bean/core";
```
to:
```typescript
import { expect, test, vi } from "vitest";
import {
  buildRouteHandler, buildThemeHandlers, buildChatHandler,
  buildListSkillsHandler, buildListProjectsHandler, buildSaveSkillHandler,
  buildPersonaHandlers,
} from "../src/ipc.js";
import type { Project, RouteSuggestion, Skill, Persona } from "@bean/core";
```

Change the existing chat-handler test from:
```typescript
test("chat handler wires skills/projects into converse", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  const handler = buildChatHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    converse: async () => ({
      content: "on it",
      toolCalls: [{ name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "go" } }],
    }),
    model: "m",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
  });
  const out = await handler({ history: [], message: "review api", droppedUrl: undefined });
  expect(out.reply).toBe("on it");
  expect(out.proposedRun?.projectPath).toBe("/work/api");
  expect(out.proposedRun?.composedPrompt).toContain("BODY");
});
```
to:
```typescript
test("chat handler wires skills/projects/persona into converse", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  const handler = buildChatHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    loadPersona: async () => ({ name: "Ponyta", tags: ["Playful"] }),
    converse: async ({ messages }) => {
      expect(messages[0]!.content).toContain("You are Ponyta");
      return {
        content: "on it",
        toolCalls: [{ name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "go" } }],
      };
    },
    model: "m",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
  });
  const out = await handler({ history: [], message: "review api", droppedUrl: undefined });
  expect(out.reply).toBe("on it");
  expect(out.proposedRun?.projectPath).toBe("/work/api");
  expect(out.proposedRun?.composedPrompt).toContain("BODY");
});
```

Then append these tests at the end of the file:
```typescript
test("getPersona handler loads persona from the configured persona file", async () => {
  const persona: Persona = { name: "Bean", tags: ["Warm"] };
  const handlers = buildPersonaHandlers({
    loadPersona: async (file) => { expect(file).toBe("/b/persona.json"); return persona; },
    savePersona: async () => {},
    personaFile: "/b/persona.json",
  });
  expect(await handlers.get()).toBe(persona);
});

test("savePersona handler writes through the injected deps with the configured persona file", async () => {
  const persona: Persona = { name: "Bean", tags: ["Warm"] };
  const savePersona = vi.fn(async () => {});
  const handlers = buildPersonaHandlers({
    loadPersona: async () => persona,
    savePersona,
    personaFile: "/b/persona.json",
  });
  await handlers.save(persona);
  expect(savePersona).toHaveBeenCalledWith("/b/persona.json", persona);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts
```
Expected: FAIL — `buildPersonaHandlers` is not exported from `../src/ipc.js`, and `buildChatHandler`'s deps type doesn't yet accept `loadPersona`/`personaFile`.

- [ ] **Step 3: Add the persona IPC channels**

In `packages/app/src/channels.ts`, change:
```typescript
  listSkills: "bean:list-skills",
  listProjects: "bean:list-projects",
  saveSkill: "bean:save-skill",
  runEvent: "bean:run-event",
```
to:
```typescript
  listSkills: "bean:list-skills",
  listProjects: "bean:list-projects",
  saveSkill: "bean:save-skill",
  getPersona: "bean:get-persona",
  savePersona: "bean:save-persona",
  runEvent: "bean:run-event",
```

- [ ] **Step 4: Update `ipc.ts`**

Change the top import from:
```typescript
import {
  route, runOpencode, converse,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest,
} from "@bean/core";
```
to:
```typescript
import {
  route, runOpencode, converse,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
} from "@bean/core";
```

Change `ChatHandlerDeps` and `buildChatHandler` from:
```typescript
export interface ChatHandlerDeps {
  loadSkills: (dir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  converse: ConverseDeps["chat"];
  model: string;
  skillsDir: string;
  projectsFile: string;
}

export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects] = await Promise.all([
      deps.loadSkills(deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
    ]);
    return converse(req.history, req.message, skills, projects, { chat: deps.converse, model: deps.model }, req.droppedUrl);
  };
}
```
to:
```typescript
export interface ChatHandlerDeps {
  loadSkills: (dir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  loadPersona: (file: string) => Promise<Persona>;
  converse: ConverseDeps["chat"];
  model: string;
  skillsDir: string;
  projectsFile: string;
  personaFile: string;
}

export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects, persona] = await Promise.all([
      deps.loadSkills(deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile),
    ]);
    return converse(req.history, req.message, skills, projects, persona, { chat: deps.converse, model: deps.model }, req.droppedUrl);
  };
}
```

After the existing `buildSaveSkillHandler` function, insert:
```typescript
export interface PersonaHandlerDeps {
  loadPersona: (file: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
}

export function buildPersonaHandlers(deps: PersonaHandlerDeps) {
  return {
    get: (): Promise<Persona> => deps.loadPersona(deps.personaFile),
    save: (persona: Persona): Promise<void> => deps.savePersona(deps.personaFile, persona),
  };
}
```

Change `RegisterDeps` from:
```typescript
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
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
  loadPersona: (file: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  sender: () => WebContents | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  openDashboard: (droppedUrl?: string) => void;
}
```

In `registerIpc`, change:
```typescript
  const saveSkillHandler = buildSaveSkillHandler(deps);
  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => saveSkillHandler(name, body));

  const theme = buildThemeHandlers(deps);
```
to:
```typescript
  const saveSkillHandler = buildSaveSkillHandler(deps);
  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => saveSkillHandler(name, body));

  const personaHandlers = buildPersonaHandlers(deps);
  ipcMain.handle(IPC.getPersona, () => personaHandlers.get());
  ipcMain.handle(IPC.savePersona, (_e, p: Persona) => personaHandlers.save(p));

  const theme = buildThemeHandlers(deps);
```

- [ ] **Step 5: Update `preload.ts`**

Change:
```typescript
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Theme } from "./channels.js";
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project } from "@bean/core";
```
to:
```typescript
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Theme } from "./channels.js";
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project, Persona } from "@bean/core";
```

Change:
```typescript
  listSkills: (): Promise<Skill[]> => ipcRenderer.invoke(IPC.listSkills),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.listProjects),
  saveSkill: (name: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.saveSkill, name, body),
});
```
to:
```typescript
  listSkills: (): Promise<Skill[]> => ipcRenderer.invoke(IPC.listSkills),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.listProjects),
  saveSkill: (name: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.saveSkill, name, body),
  getPersona: (): Promise<Persona> => ipcRenderer.invoke(IPC.getPersona),
  savePersona: (p: Persona): Promise<void> => ipcRenderer.invoke(IPC.savePersona, p),
});
```

- [ ] **Step 6: Update `bean.d.ts`**

Change:
```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project } from "@bean/core";
```
to:
```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project, Persona } from "@bean/core";
```

Change:
```typescript
      listSkills(): Promise<Skill[]>;
      listProjects(): Promise<Project[]>;
      saveSkill(name: string, body: string): Promise<void>;
    };
```
to:
```typescript
      listSkills(): Promise<Skill[]>;
      listProjects(): Promise<Project[]>;
      saveSkill(name: string, body: string): Promise<void>;
      getPersona(): Promise<Persona>;
      savePersona(p: Persona): Promise<void>;
    };
```

- [ ] **Step 7: Wire `main.ts`**

Change:
```typescript
import {
  beanDir, configFile, projectsFile, skillsDir,
  loadConfig, loadSkills, loadProjects, saveSkill, makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
```
to:
```typescript
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile,
  loadConfig, loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
  makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
```

Change:
```typescript
    registerIpc(ipcMain, {
      loadSkills, loadProjects, saveSkill,
      chat: makeOpenAIChat(cfg.openaiApiKey),
      converse: makeOpenAIConverse(cfg.openaiApiKey),
      model: cfg.model,
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      sender: () => dashboardWin?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openDashboard,
    });
```
to:
```typescript
    registerIpc(ipcMain, {
      loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
      chat: makeOpenAIChat(cfg.openaiApiKey),
      converse: makeOpenAIConverse(cfg.openaiApiKey),
      model: cfg.model,
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      personaFile: personaFile(dir),
      sender: () => dashboardWin?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openDashboard,
    });
```

- [ ] **Step 8: Run the tests and typecheck to verify everything passes**

Run:
```bash
pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts && pnpm typecheck
```
Expected: `ipc.test.ts` PASS (9 tests); `typecheck` exits 0 across both packages (this confirms `main.ts` and `preload.ts` satisfy the updated `RegisterDeps`/bridge shapes).

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/main.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): add getPersona/savePersona IPC surface"
```

---

### Task 4: `PersonaPanel` component + styling (`@bean/app`)

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx`
- Modify: `packages/app/src/renderer/dashboard.css`

**Interfaces:**
- Consumes: `window.bean.getPersona()`/`window.bean.savePersona()` (Task 3); `PERSONA_TAGS`, `type Persona`, `type PersonaTag` from `@bean/core/persona` (Task 1); `PanelHeader` from `../Panel.js` (existing).
- Produces: nothing new consumed by later tasks — `PersonaPanel` is already rendered with no props by `App.tsx` (confirm this is still true in Step 1 before writing any code; no `App.tsx` change is expected in this task).

This task has no dedicated unit test — `PersonaPanel` is UI-only and, per the SP1–SP4 convention already established in this repo, renderer components are verified manually via `pnpm dev` (Task 5) rather than with DOM tests. Treat "the app builds and the manual checklist in Task 5 passes" as this task's verification.

- [ ] **Step 1: Confirm `App.tsx` already renders `PersonaPanel` with no props**

Run:
```bash
grep -n "PersonaPanel" packages/app/src/renderer/dashboard/App.tsx
```
Expected: two lines — the import, and `<PersonaPanel />` with no props passed. If this is not the case, stop and reconcile with the spec before proceeding (this plan assumes it's already wired, discovered during SP5 brainstorming).

- [ ] **Step 2: Replace `PersonaPanel.tsx`**

Replace the full contents of `packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx` with:
```tsx
import { useEffect, useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import { PERSONA_TAGS, type Persona, type PersonaTag } from "@bean/core/persona";

const SAMPLE_VOICE = "“Done — left two notes on the retry loop. Want me to open the PR?”";

type Mode = "view" | "edit";

export function PersonaPanel() {
  const [persona, setPersona] = useState<Persona | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [draftName, setDraftName] = useState("");
  const [draftTags, setDraftTags] = useState<PersonaTag[]>([]);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    setPersona(await window.bean.getPersona());
  };

  useEffect(() => { void refresh(); }, []);

  const startEdit = (): void => {
    if (!persona) return;
    setDraftName(persona.name);
    setDraftTags([...persona.tags]);
    setSaveError(undefined);
    setMode("edit");
  };

  const cancelEdit = (): void => {
    setMode("view");
    setSaveError(undefined);
  };

  const toggleTag = (tag: PersonaTag): void => {
    setDraftTags((prev) => {
      if (prev.includes(tag)) return prev.length > 1 ? prev.filter((t) => t !== tag) : prev;
      return [...prev, tag];
    });
  };

  const save = async (): Promise<void> => {
    try {
      await window.bean.savePersona({ name: draftName.trim(), tags: draftTags });
      await refresh();
      setMode("view");
      setSaveError(undefined);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!persona) {
    return (
      <div class="bean-panel">
        <PanelHeader title="Persona" />
        <div class="bean-panel-empty">Loading persona…</div>
      </div>
    );
  }

  return (
    <div class="bean-panel">
      <PanelHeader title="Persona" />
      <div class="bean-persona">
        <div class="bean-persona-label">NAME</div>
        {mode === "view" ? (
          <div class="bean-persona-name">{persona.name}</div>
        ) : (
          <input
            class="bean-input bean-persona-name-input"
            value={draftName}
            onInput={(e) => setDraftName((e.target as HTMLInputElement).value)}
          />
        )}

        <div class="bean-persona-label">TONE</div>
        <div class="bean-persona-tags">
          {mode === "view"
            ? persona.tags.map((tag) => <span key={tag} class="bean-chip">{tag}</span>)
            : PERSONA_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  class={`bean-tag-chip${draftTags.includes(tag) ? " bean-tag-chip--selected" : ""}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
        </div>

        {mode === "view" ? (
          <>
            <div class="bean-persona-label">SAMPLE VOICE</div>
            <div class="bean-persona-sample">{SAMPLE_VOICE}</div>
          </>
        ) : null}

        {saveError ? <div class="bean-persona-error">Save failed: {saveError}</div> : null}

        <div class="bean-card-actions">
          {mode === "view" ? (
            <button type="button" class="bean-btn" onClick={startEdit}>Edit</button>
          ) : (
            <>
              <button type="button" class="bean-btn" onClick={() => void save()}>Save</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelEdit}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the persona CSS**

At the end of `packages/app/src/renderer/dashboard.css`, append:
```css
/* --- persona (SP5) --- */
.bean-persona {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bean-persona-label {
  font-size: 11px;
  color: var(--bean-text-dim);
  margin-top: 6px;
}
.bean-persona-label:first-child { margin-top: 0; }
.bean-persona-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--bean-text);
}
.bean-persona-name-input {
  width: 100%;
  box-sizing: border-box;
}
.bean-persona-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.bean-tag-chip {
  font-size: 12.5px;
  color: var(--bean-text);
  background: transparent;
  border: 1px solid var(--bean-border);
  border-radius: 999px;
  padding: 5px 12px;
  cursor: pointer;
}
.bean-tag-chip--selected {
  color: var(--bean-accent-ink);
  background: var(--bean-accent);
  border-color: var(--bean-accent);
  font-weight: 600;
}
.bean-persona-sample {
  font-size: 13.5px;
  font-style: italic;
  line-height: 1.5;
  color: var(--bean-text-dim);
}
.bean-persona-error {
  font-size: 12px;
  color: #e5484d;
}
```

- [ ] **Step 4: Build the app to verify the browser bundle resolves cleanly**

Run:
```bash
pnpm --filter @bean/core build && pnpm --filter @bean/app build
```
Expected: exits 0. This is the step that would fail if `PERSONA_TAGS` were imported from the main `@bean/core` barrel instead of `@bean/core/persona` — esbuild's `platform: "browser"` build would try to resolve `node:fs`/`node:path` (pulled in transitively via `config.js`/`skill-library.js`/etc.) and error, exactly as SP3 hit before its `@bean/core/terminal` fix. If this step fails with a `node:*` resolution error, check the import line in `PersonaPanel.tsx` first.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx packages/app/src/renderer/dashboard.css
git commit -m "feat(app): build editable PersonaPanel view/edit UI"
```

---

### Task 5: Full validation + manual verification + ledger update

**Files:**
- Modify: `docs/superpowers/bean-redesign-playbook.md` (status ledger)
- Modify: `.memory/project-dashboard-redesign-roadmap.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing — this is the closing task.

- [ ] **Step 1: Run the full validation gate, cache-free**

Run each of these individually (not relying on Turbo cache):
```bash
pnpm --filter @bean/core exec vitest run
pnpm --filter @bean/app exec vitest run
pnpm --filter @bean/core exec tsc -p packages/core/tsconfig.json --noEmit
pnpm --filter @bean/app exec tsc -p packages/app/tsconfig.json --noEmit
pnpm --filter @bean/app build
```
Expected: every command exits 0. If any fails, fix it before moving on — do not proceed to the manual checklist with a red gate.

- [ ] **Step 2: Manual verification walkthrough**

Start the app (`pnpm dev`) and, using a GUI-capable tool if available in this environment (e.g. a browser-automation/screenshot MCP), or by reading the rendered output/DOM if not, walk through:

- Open the dashboard with no `~/.bean/persona.json` present → Persona panel shows name "Bean", exactly the three default tags (`Warm`, `Concise`, `Direct`) as chips, and the fixed sample-voice line.
- Click `Edit` → name input pre-filled "Bean", all six tag chips shown, the three defaults visually selected.
- Change the name, toggle a tag off and another on, click `Save` → panel returns to view mode reflecting the new name and tags; `~/.bean/persona.json` now exists on disk with that exact content (`cat ~/.bean/persona.json` to confirm).
- Reload the dashboard window → the saved persona (not the default) is what loads.
- Click `Edit`, clear the name field entirely, click `Save` → an inline error appears, the edit form stays open with the (empty) draft intact, no file is overwritten.
- Click `Edit`, deselect tags down to the last one, then click that last selected tag again → it stays selected (no-op) — never reaches zero tags.
- Click `Edit`, make changes, click `Cancel` → the file on disk and the view-mode display are unchanged.
- Send a chat message after changing the persona name/tags → there's no manual way to inspect the raw system prompt without model/logging access, so treat this as verified structurally by the `converse.test.ts` composition tests (Task 2) rather than by observing live model output; note this explicitly in your report rather than skipping the step silently.
- Toggle Hearth/Graphite → the panel restyles like other panels.

If this environment has no GUI-automation/screenshot tool, substitute: re-read the diffed files against this plan, confirm the unit tests above cover the `persona-store.ts`/`converse.ts` logic these steps exercise, and do a `pnpm dev` process-start check (main/gpu/renderer/network processes come up, no crash in `pnpm dev`'s output) as an indirect runtime signal — same substitution SP3/SP4 used. Note explicitly in your final report which of these two paths you used.

- [ ] **Step 3: Update the status ledger**

In `docs/superpowers/bean-redesign-playbook.md`, change the SP5 row of the §1 table from:
```
| 5 | Persona panel: name/tone/voice. **Open decision at design time:** editable vs decorative. Also lift the `DEFAULT_SYSTEM_PROMPT` constant out of `packages/core/src/converse.ts` into configurable persona. | — | — | ⬜ not started |
```
to:
```
| 5 | Persona panel: editable name + preset tone tags, persisted to `~/.bean/persona.json`, driving `converse()`'s system prompt via `composePersonaPrompt`. | `specs/2026-06-30-bean-persona-panel-design.md` | `plans/2026-06-30-bean-persona-panel.md` | ✅ done + reviewed |
```
(Adjust the status to whatever this task's actual outcome was — e.g. if Step 2 could only use the indirect substitution path, say so here as SP3/SP4's rows do, rather than claiming a full GUI walkthrough that didn't happen.)

- [ ] **Step 4: Update the roadmap memory**

In `.memory/project-dashboard-redesign-roadmap.md`, add a sentence to the running status paragraph describing SP5's outcome — what shipped (`persona.ts`/`persona-store.ts`/`@bean/core/persona` subpath, the `converse()` signature change, the IPC surface, the panel), and explicitly flag the **browser-bundle-safety pattern** (any new renderer-facing runtime value from `@bean/core` needs its own Node-free subpath, per `persona.ts`/`terminal.ts`) as a convention future SPs (SP6) should follow. Follow the existing paragraph's style — dense prose, not bullets — and keep `.memory/INDEX.md`'s one-line summary for this entry accurate if anything material changed.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/bean-redesign-playbook.md .memory/project-dashboard-redesign-roadmap.md
git commit -m "docs(sp5): mark persona panel done and update ledger"
```
</content>
