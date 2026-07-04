# Bean's Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Bean a curated, user-editable memory that is extracted (with confirmation) when the chat panel closes and recalled when it reopens, and make the chat orchestrator aware of only enabled skills.

**Architecture:** New pure `@bean/core` modules (`memory`, `memory-store`, `memory-extract`) mirror the existing `persona-store`/`converse` dependency-injected style. `converse()` gains a `memories` parameter that injects a recall block. The Electron app loads memories into the chat handler (filtering skills to enabled ones), exposes list/save/extract IPC, intercepts the chat window's `close` to run a confirm-at-close review, and adds a memory section to the persona panel.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`, `strict` + `noUncheckedIndexedAccess`), pnpm workspace, Turborepo, Vitest, Electron, Preact.

## Global Constraints

- **Files:** kebab-case `.ts`. Relative imports use `.js` extensions; type-only imports use `import type`.
- **Core purity:** `@bean/core` stays Electron-free and dependency-injected. Missing/invalid data degrades to `[]`, never throws (except `savePersona`-style validators, not used here).
- **Renderer imports:** renderer imports core *values* only from node-free subpaths; import core *types* from the barrel with `import type`. `Memory`/`MemoryCandidate`/`ChatTurn` are types, so barrel `import type` is fine.
- **IPC channels:** channel strings live only in `packages/app/src/channels.ts` (`convention-ipc-channels`); never string-literal them elsewhere.
- **Preload stays CJS** (`safety-preload-must-be-cjs`) — do not add ESM-only syntax to `preload.ts`.
- **Window rules** (`safety-window-behavior`): chat is its own component window; the close-review must not touch the shared avatar/intake window.
- **Validation gate:** `pnpm test && pnpm typecheck` must exit 0 before a task is done.

---

### Task 1: Memory model

**Files:**
- Create: `packages/core/src/memory.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/__test__/memory.test.ts`

**Interfaces:**
- Produces: `interface Memory { id: string; text: string; projectPath?: string; createdAt: string }`, `interface MemoryCandidate { text: string; projectPath?: string }`, `function isValidMemory(v: unknown): v is Memory`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/memory.test.ts`:

```ts
import { expect, test } from "vitest";
import { isValidMemory, type Memory } from "../src/memory.js";

const good: Memory = { id: "a1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" };

test("a well-formed memory passes validation", () => {
  expect(isValidMemory(good)).toBe(true);
});

test("a memory with an optional projectPath passes validation", () => {
  expect(isValidMemory({ ...good, projectPath: "/work/api" })).toBe(true);
});

test("missing/blank id, text, or createdAt fails validation", () => {
  expect(isValidMemory({ ...good, id: "" })).toBe(false);
  expect(isValidMemory({ ...good, text: "   " })).toBe(false);
  expect(isValidMemory({ ...good, createdAt: 123 })).toBe(false);
});

test("a non-string projectPath fails validation", () => {
  expect(isValidMemory({ ...good, projectPath: 42 })).toBe(false);
});

test("non-objects fail validation", () => {
  expect(isValidMemory(null)).toBe(false);
  expect(isValidMemory("nope")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/memory.test.ts`
Expected: FAIL — cannot resolve `../src/memory.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/memory.ts`:

```ts
export interface Memory {
  id: string;
  text: string;
  projectPath?: string;
  createdAt: string;
}

export interface MemoryCandidate {
  text: string;
  projectPath?: string;
}

export function isValidMemory(v: unknown): v is Memory {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.trim() === "") return false;
  if (typeof m.text !== "string" || m.text.trim() === "") return false;
  if (typeof m.createdAt !== "string" || m.createdAt.trim() === "") return false;
  if (m.projectPath !== undefined && typeof m.projectPath !== "string") return false;
  return true;
}
```

Add to `packages/core/src/index.ts` (after the `./persona-store.js` line):

```ts
export * from "./memory.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/memory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory.ts packages/core/src/index.ts packages/core/__test__/memory.test.ts
git commit -m "feat(core): add Memory model and isValidMemory"
```

---

### Task 2: Memory store + config path

**Files:**
- Create: `packages/core/src/memory-store.ts`
- Modify: `packages/core/src/config.ts`, `packages/core/src/index.ts`
- Test: `packages/core/__test__/memory-store.test.ts`

**Interfaces:**
- Consumes: `Memory`, `isValidMemory` (Task 1).
- Produces: `function loadMemories(file: string): Promise<Memory[]>`, `function saveMemories(file: string, memories: Memory[]): Promise<void>`, `function memoryFile(dir: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/memory-store.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemories, saveMemories } from "../src/memory-store.js";
import type { Memory } from "../src/memory.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-memory-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const m = (id: string, text: string): Memory => ({ id, text, createdAt: "2026-07-03T00:00:00.000Z" });

test("missing file returns an empty array", async () => {
  expect(await loadMemories(join(dir, "memory.json"))).toEqual([]);
});

test("invalid JSON returns an empty array", async () => {
  const file = join(dir, "memory.json");
  await writeFile(file, "{ not json");
  expect(await loadMemories(file)).toEqual([]);
});

test("a non-array payload returns an empty array", async () => {
  const file = join(dir, "memory.json");
  await writeFile(file, JSON.stringify({ id: "x" }));
  expect(await loadMemories(file)).toEqual([]);
});

test("invalid entries are dropped, valid ones kept", async () => {
  const file = join(dir, "memory.json");
  await writeFile(file, JSON.stringify([m("a", "keep"), { id: "", text: "drop", createdAt: "z" }]));
  expect(await loadMemories(file)).toEqual([m("a", "keep")]);
});

test("save then load round-trips and creates missing parent dirs", async () => {
  const file = join(dir, "nested", "memory.json");
  const memories = [m("a", "prefers pnpm"), { ...m("b", "auth in core"), projectPath: "/work/api" }];
  await saveMemories(file, memories);
  expect(await loadMemories(file)).toEqual(memories);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/memory-store.test.ts`
Expected: FAIL — cannot resolve `../src/memory-store.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/memory-store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isValidMemory, type Memory } from "./memory.js";

export async function loadMemories(file: string): Promise<Memory[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMemory);
  } catch {
    return [];
  }
}

export async function saveMemories(file: string, memories: Memory[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(memories, null, 2) + "\n", "utf8");
}
```

Add to `packages/core/src/config.ts` (next to `personaFile`):

```ts
export function memoryFile(dir: string): string { return join(dir, "memory.json"); }
```

Add to `packages/core/src/index.ts` (after the new `./memory.js` line):

```ts
export * from "./memory-store.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/memory-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory-store.ts packages/core/src/config.ts packages/core/src/index.ts packages/core/__test__/memory-store.test.ts
git commit -m "feat(core): add memory-store and memoryFile path helper"
```

---

### Task 3: Memory extraction

**Files:**
- Create: `packages/core/src/memory-extract.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/__test__/memory-extract.test.ts`

**Interfaces:**
- Consumes: `ConverseDeps`, `ChatTurn`, `ToolSpec`, `ToolCall`, `ConvoMsg` (from `converse.ts`); `Memory`, `MemoryCandidate` (Task 1); `Project` (from `types.ts`).
- Produces: `function extractMemories(transcript: ChatTurn[], existing: Memory[], projects: Project[], deps: ConverseDeps): Promise<MemoryCandidate[]>`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/memory-extract.test.ts`:

```ts
import { expect, test } from "vitest";
import { extractMemories } from "../src/memory-extract.js";
import type { ConverseDeps, ToolSpec } from "../src/converse.js";
import type { Memory } from "../src/memory.js";
import type { Project } from "../src/types.js";

const projects: Project[] = [
  { name: "api", path: "/work/api" },
  { name: "bean", path: "/dev/bean" },
];
const transcript = [
  { role: "user" as const, content: "I always use pnpm, never npm" },
  { role: "assistant" as const, content: "Noted." },
];

function depsReturning(toolCalls: { name: string; args: unknown }[]): ConverseDeps {
  return { model: "m", chat: async () => ({ content: "", toolCalls }) };
}

test("empty transcript short-circuits to no candidates and never calls chat", async () => {
  let called = false;
  const deps: ConverseDeps = { model: "m", chat: async () => { called = true; return { content: "", toolCalls: [] }; } };
  expect(await extractMemories([], [], projects, deps)).toEqual([]);
  expect(called).toBe(false);
});

test("remember tool calls become candidates; a valid projectPath is kept", async () => {
  const deps = depsReturning([
    { name: "remember", args: { text: "prefers pnpm" } },
    { name: "remember", args: { text: "auth lives in core", projectPath: "/work/api" } },
  ]);
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([
    { text: "prefers pnpm", projectPath: undefined },
    { text: "auth lives in core", projectPath: "/work/api" },
  ]);
});

test("an unknown projectPath is dropped to a global candidate", async () => {
  const deps = depsReturning([{ name: "remember", args: { text: "x", projectPath: "/nowhere" } }]);
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([{ text: "x", projectPath: undefined }]);
});

test("blank/missing text and non-remember calls are skipped", async () => {
  const deps = depsReturning([
    { name: "remember", args: { text: "   " } },
    { name: "other", args: { text: "ignore" } },
    { name: "remember", args: {} },
  ]);
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([]);
});

test("candidates duplicating existing memory (case-insensitive) are dropped", async () => {
  const existing: Memory[] = [{ id: "1", text: "Prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const deps = depsReturning([
    { name: "remember", args: { text: "prefers pnpm" } },
    { name: "remember", args: { text: "new fact" } },
  ]);
  expect(await extractMemories(transcript, existing, projects, deps)).toEqual([{ text: "new fact", projectPath: undefined }]);
});

test("a chat failure yields no candidates (never throws)", async () => {
  const deps: ConverseDeps = { model: "m", chat: async () => { throw new Error("network"); } };
  expect(await extractMemories(transcript, [], projects, deps)).toEqual([]);
});

test("the remember tool constrains projectPath to known project paths", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = { model: "m", chat: async ({ tools }) => { captured = tools; return { content: "", toolCalls: [] }; } };
  await extractMemories(transcript, [], projects, deps);
  const props = (captured[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.projectPath?.enum).toEqual(["/work/api", "/dev/bean"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/memory-extract.test.ts`
Expected: FAIL — cannot resolve `../src/memory-extract.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/memory-extract.ts`:

```ts
import type { ChatTurn, ConvoMsg, ConverseDeps, ToolCall, ToolSpec } from "./converse.js";
import type { Memory, MemoryCandidate } from "./memory.js";
import type { Project } from "./types.js";

const EXTRACT_INSTRUCTIONS =
  "You are reviewing a finished conversation to decide what — if anything — is worth " +
  "remembering long-term about the user or their projects. Call the remember tool once per " +
  "fact worth keeping. Remember ONLY durable, reusable facts: the user's stable preferences " +
  "and working style, and project conventions, decisions, or gotchas. Do NOT remember one-off " +
  "task details, transient state, anything already in the existing memory list, or small talk. " +
  "If nothing meets that bar, call no tools. Tag a fact with a projectPath only when it is " +
  "clearly about that specific project; otherwise leave it global.";

function rememberTool(projects: Project[]): ToolSpec {
  const properties: Record<string, unknown> = {
    text: { type: "string", description: "the fact to remember, as one concise sentence" },
  };
  if (projects.length > 0) {
    properties.projectPath = {
      type: "string",
      enum: projects.map((p) => p.path),
      description: "the project this fact is about; omit for a global fact about the user",
    };
  }
  return {
    name: "remember",
    description: "Record one durable fact worth remembering about the user or a project.",
    parameters: { type: "object", properties, required: ["text"] },
  };
}

function existingBlock(existing: Memory[]): string {
  if (existing.length === 0) return "Existing memory is empty.";
  return "Already remembered (do not repeat):\n" + existing.map((m) => `- ${m.text}`).join("\n");
}

export async function extractMemories(
  transcript: ChatTurn[],
  existing: Memory[],
  projects: Project[],
  deps: ConverseDeps,
): Promise<MemoryCandidate[]> {
  if (transcript.length === 0) return [];

  const messages: ConvoMsg[] = [
    { role: "system", content: `${EXTRACT_INSTRUCTIONS}\n\n${existingBlock(existing)}` },
    { role: "user", content: `Conversation:\n${transcript.map((t) => `${t.role}: ${t.content}`).join("\n")}` },
  ];

  let toolCalls: ToolCall[] = [];
  try {
    const res = await deps.chat({ model: deps.model, messages, tools: [rememberTool(projects)] });
    toolCalls = res.toolCalls;
  } catch {
    return [];
  }

  const known = new Set(projects.map((p) => p.path));
  const seen = new Set(existing.map((m) => m.text.trim().toLowerCase()));
  const out: MemoryCandidate[] = [];
  for (const call of toolCalls) {
    if (call.name !== "remember") continue;
    const args = (call.args ?? {}) as { text?: unknown; projectPath?: unknown };
    if (typeof args.text !== "string" || args.text.trim() === "") continue;
    const key = args.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const projectPath =
      typeof args.projectPath === "string" && known.has(args.projectPath) ? args.projectPath : undefined;
    out.push({ text: args.text.trim(), projectPath });
  }
  return out;
}
```

Add to `packages/core/src/index.ts` (after the new `./memory-store.js` line):

```ts
export * from "./memory-extract.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/memory-extract.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory-extract.ts packages/core/src/index.ts packages/core/__test__/memory-extract.test.ts
git commit -m "feat(core): add extractMemories (remember-tool pass over a transcript)"
```

---

### Task 4: Recall in converse()

**Files:**
- Modify: `packages/core/src/converse.ts`
- Test: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: `Memory` (Task 1).
- Produces: new `converse` signature — `converse(history, latestUserText, skills, projects, persona, memories: Memory[], deps, droppedUrl?)`. The `memories` parameter is inserted **after `persona`, before `deps`**. All existing call sites must pass `memories` (use `[]` when none).

- [ ] **Step 1: Write the failing test**

Add these tests to `packages/core/__test__/converse.test.ts`:

```ts
test("recalled memories are injected after the catalog, labeled global vs project", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { systemContent = messages[0]!.content; return { content: "ok", toolCalls: [] }; },
  };
  const memories = [
    { id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" },
    { id: "2", text: "preload must stay CJS", projectPath: "/dev/bean", createdAt: "2026-07-03T00:00:00.000Z" },
  ];
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, memories, deps);
  const catalogIdx = systemContent.indexOf("Skills:");
  const memIdx = systemContent.indexOf("What you remember:");
  expect(memIdx).toBeGreaterThan(catalogIdx);
  expect(systemContent).toContain("- (about the user) prefers pnpm");
  expect(systemContent).toContain("- (project bean) preload must stay CJS");
});

test("no memory block is added when memories is empty", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { systemContent = messages[0]!.content; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(systemContent).not.toContain("What you remember:");
});
```

Also update **every existing `converse(...)` call** in this file to insert `[]` as the sixth argument (after the persona, before `deps`). The existing calls to update are on lines with `DEFAULT_PERSONA, deps` / `DEFAULT_PERSONA, depsReturning(...)` / `persona, deps`:

```ts
// each existing call like:
//   await converse([], "hi there", skills, projects, DEFAULT_PERSONA, depsReturning("Hello!"));
// becomes:
//   await converse([], "hi there", skills, projects, DEFAULT_PERSONA, [], depsReturning("Hello!"));
```

Apply that `[], ` insertion to all six pre-existing `converse(` calls (the plain-reply, valid-propose_run, unknown-skill, enum-constrained, empty-skills/projects, history-never-throws, and system-prompt-order tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: FAIL — the two new tests fail to compile/pass because `converse` doesn't accept a `memories` argument yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/converse.ts`, add the import at the top (with the other type imports):

```ts
import type { Project, RouteSuggestion, Skill } from "./types.js";
import type { Memory } from "./memory.js";
```

Add this helper next to `catalog()`:

```ts
function memoriesBlock(memories: Memory[], projects: Project[]): string {
  if (memories.length === 0) return "";
  const nameFor = (path: string): string => projects.find((p) => p.path === path)?.name ?? path;
  const ordered = [...memories].sort((a, b) => Number(Boolean(a.projectPath)) - Number(Boolean(b.projectPath)));
  const lines = ordered.map((m) =>
    m.projectPath ? `- (project ${nameFor(m.projectPath)}) ${m.text}` : `- (about the user) ${m.text}`,
  );
  return `What you remember:\n${lines.join("\n")}`;
}
```

Change the `converse` signature to accept `memories` after `persona`:

```ts
export async function converse(
  history: ChatTurn[],
  latestUserText: string,
  skills: Skill[],
  projects: Project[],
  persona: Persona,
  memories: Memory[],
  deps: ConverseDeps,
  droppedUrl?: string,
): Promise<ConverseResult> {
  const systemParts = [composePersonaPrompt(persona), BEHAVIOR_INSTRUCTIONS, catalog(skills, projects)];
  const recall = memoriesBlock(memories, projects);
  if (recall) systemParts.push(recall);

  const messages: ConvoMsg[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...history.map((t): ConvoMsg => ({ role: t.role, content: t.content })),
    { role: "user", content: latestUserText },
  ];
```

Leave the rest of the function body unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS (all prior tests + 2 new).

- [ ] **Step 5: Full core gate + commit**

Run: `pnpm --filter @bean/core test && pnpm --filter @bean/core exec tsc --noEmit`
Expected: PASS / exit 0.

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): recall memories into the converse system prompt"
```

---

### Task 5: Chat handler — enabled-skill filter + memory recall

**Files:**
- Modify: `packages/app/src/ipc.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `converse` (new signature, Task 4), `loadMemories` (Task 2), `Memory`.
- Produces: `ChatHandlerDeps` gains `loadMemories: (file: string) => Promise<Memory[]>` and `memoryFile: string`. `buildChatHandler` filters `enabled !== false` skills and injects loaded memories.

- [ ] **Step 1: Write the failing test**

In `packages/app/__test__/ipc.test.ts`, update the existing `"chat handler wires skills/projects/persona into converse"` test's deps object to add the two new fields (place them beside `personaFile`):

```ts
    loadMemories: async () => [],
    memoryFile: "/b/memory.json",
```

Then add a new test after it:

```ts
test("chat handler drops disabled skills and injects recalled memories", async () => {
  const skills: Skill[] = [
    { name: "review-code", description: "r", body: "BODY", enabled: true },
    { name: "hidden", description: "h", body: "H", enabled: false },
  ];
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  let systemContent = "";
  const handler = buildChatHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ messages, tools }) => {
      systemContent = messages[0]!.content;
      const props = (tools[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props.skill?.enum).toEqual(["review-code"]); // "hidden" excluded
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }],
    memoryFile: "/b/memory.json",
  });
  await handler({ history: [], message: "hi" });
  expect(systemContent).toContain("What you remember:");
  expect(systemContent).toContain("prefers pnpm");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildChatHandler` deps type lacks `loadMemories`/`memoryFile`, and the handler doesn't filter skills yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/ipc.ts`, add `Memory` to the core type imports:

```ts
import {
  route, converse, launchInTerminal,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type LaunchRequest, type LaunchSpawnFn, type Memory,
} from "@bean/core";
```

Extend `ChatHandlerDeps`:

```ts
export interface ChatHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  loadMemories: (file: string) => Promise<Memory[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
  personaFile: string;
  projectPersonaFile: string;
  memoryFile: string;
}
```

Rewrite `buildChatHandler`:

```ts
export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects, persona, memories] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
      deps.loadMemories(deps.memoryFile),
    ]);
    const enabled = skills.filter((s) => s.enabled !== false);
    return converse(
      req.history, req.message, enabled, projects, persona, memories,
      { chat: deps.converse, model: deps.getModel() }, req.droppedUrl,
    );
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): chat handler filters enabled skills and recalls memories"
```

---

### Task 6: Memory IPC — list/save/extract handlers + bridge

**Files:**
- Modify: `packages/app/src/ipc.ts`, `packages/app/src/channels.ts`, `packages/app/src/preload.ts`, `packages/app/src/renderer/bean.d.ts`, `packages/app/src/main.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `loadMemories`, `saveMemories` (Task 2), `extractMemories` (Task 3), `Memory`, `MemoryCandidate`, `ChatTurn`.
- Produces: `buildMemoryHandlers(deps): { list; save; extract }`; new IPC channels `listMemories`, `saveMemories`, `extractMemories`, `reviewBeforeClose`, `allowChatClose`; matching `window.bean` methods.

- [ ] **Step 1: Write the failing test**

Add to `packages/app/__test__/ipc.test.ts` (and add `buildMemoryHandlers` to the import from `../src/ipc.js`, plus `MemoryCandidate` to the `@bean/core` type import):

```ts
test("memory handlers list, save, and extract through injected deps", async () => {
  let saved: unknown[] = [];
  const existing = [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const handlers = buildMemoryHandlers({
    loadMemories: async () => existing,
    saveMemories: async (_file, memories) => { saved = memories; },
    extractMemories: async (transcript, ex, projects) => {
      expect(ex).toEqual(existing);
      expect(projects).toEqual([{ name: "api", path: "/work/api" }]);
      return transcript.length ? [{ text: "new fact", projectPath: undefined }] : [];
    },
    loadProjects: async () => [{ name: "api", path: "/work/api" }],
    converse: async () => ({ content: "", toolCalls: [] }),
    getModel: () => "m",
    memoryFile: "/b/memory.json",
    projectsFile: "/b/projects.json",
  });

  expect(await handlers.list()).toEqual(existing);
  await handlers.save([{ id: "2", text: "x", createdAt: "2026-07-03T00:00:00.000Z" }]);
  expect(saved).toHaveLength(1);
  expect(await handlers.extract([{ role: "user", content: "hi" }])).toEqual([{ text: "new fact", projectPath: undefined }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildMemoryHandlers` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/ipc.ts`, extend the core import to also bring `ChatTurn` and `MemoryCandidate` types:

```ts
  type LaunchRequest, type LaunchSpawnFn, type Memory, type MemoryCandidate, type ChatTurn,
```

Add the handler factory (near `buildPersonaHandlers`):

```ts
export interface MemoryHandlerDeps {
  loadMemories: (file: string) => Promise<Memory[]>;
  saveMemories: (file: string, memories: Memory[]) => Promise<void>;
  extractMemories: (
    transcript: ChatTurn[], existing: Memory[], projects: Project[], deps: ConverseDeps,
  ) => Promise<MemoryCandidate[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  memoryFile: string;
  projectsFile: string;
}

export function buildMemoryHandlers(deps: MemoryHandlerDeps) {
  return {
    list: (): Promise<Memory[]> => deps.loadMemories(deps.memoryFile),
    save: (memories: Memory[]): Promise<void> => deps.saveMemories(deps.memoryFile, memories),
    extract: async (transcript: ChatTurn[]): Promise<MemoryCandidate[]> => {
      const [existing, projects] = await Promise.all([
        deps.loadMemories(deps.memoryFile),
        deps.loadProjects(deps.projectsFile),
      ]);
      return deps.extractMemories(transcript, existing, projects, { chat: deps.converse, model: deps.getModel() });
    },
  };
}
```

Extend `RegisterDeps` (add these fields):

```ts
  loadMemories: (file: string) => Promise<Memory[]>;
  saveMemories: (file: string, memories: Memory[]) => Promise<void>;
  extractMemories: MemoryHandlerDeps["extractMemories"];
  memoryFile: string;
```

Register the handlers inside `registerIpc` (after the persona handlers):

```ts
  const memoryHandlers = buildMemoryHandlers(deps);
  ipcMain.handle(IPC.listMemories, () => memoryHandlers.list());
  ipcMain.handle(IPC.saveMemories, (_e, memories: Memory[]) => memoryHandlers.save(memories));
  ipcMain.handle(IPC.extractMemories, (_e, transcript: ChatTurn[]) => memoryHandlers.extract(transcript));
```

In `packages/app/src/channels.ts`, add to the `IPC` object (before the closing `} as const`):

```ts
  listMemories: "bean:list-memories",
  saveMemories: "bean:save-memories",
  extractMemories: "bean:extract-memories",
  reviewBeforeClose: "bean:review-before-close",
  allowChatClose: "bean:allow-chat-close",
```

In `packages/app/src/preload.ts`, extend the core type import with `MemoryCandidate` and `ChatTurn`:

```ts
import type {
  RouteInput, RouteSuggestion, ChatRequest, ConverseResult, Skill, Project, Persona, LaunchRequest,
  Memory, MemoryCandidate, ChatTurn,
} from "@bean/core";
```

Add these methods to the `exposeInMainWorld("bean", { ... })` object:

```ts
  listMemories: (): Promise<Memory[]> => ipcRenderer.invoke(IPC.listMemories),
  saveMemories: (memories: Memory[]): Promise<void> => ipcRenderer.invoke(IPC.saveMemories, memories),
  extractMemories: (transcript: ChatTurn[]): Promise<MemoryCandidate[]> =>
    ipcRenderer.invoke(IPC.extractMemories, transcript),
  onReviewBeforeClose: (cb: () => void) => ipcRenderer.on(IPC.reviewBeforeClose, () => cb()),
  allowChatClose: (): void => ipcRenderer.send(IPC.allowChatClose),
```

In `packages/app/src/renderer/bean.d.ts`, extend the core type import the same way (`Memory, MemoryCandidate, ChatTurn`) and add to the `bean` interface:

```ts
      listMemories(): Promise<Memory[]>;
      saveMemories(memories: Memory[]): Promise<void>;
      extractMemories(transcript: ChatTurn[]): Promise<MemoryCandidate[]>;
      onReviewBeforeClose(cb: () => void): void;
      allowChatClose(): void;
```

In `packages/app/src/main.ts`, extend the `@bean/core` import with the new functions and `memoryFile`:

```ts
  beanDir, configFile, projectsFile, skillsDir, personaFile, projectBeanDir, memoryFile,
  loadConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona, saveConfig,
  loadMemories, saveMemories, extractMemories,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill,
```

Add these fields to the `registerIpc(ipcMain, { ... })` deps object (next to `personaFile`/`projectPersonaFile`):

```ts
      loadMemories, saveMemories, extractMemories,
      memoryFile: memoryFile(dir),
```

- [ ] **Step 4: Run tests + typecheck to verify**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts && pnpm typecheck`
Expected: PASS / exit 0. (`pnpm typecheck` confirms preload, bean.d.ts, and main.ts wiring all line up.)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/ipc.ts packages/app/src/channels.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/main.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): memory list/save/extract IPC and close-review channels"
```

---

### Task 7: Confirm-at-close review flow

**Files:**
- Modify: `packages/app/src/main.ts` (chat window close intercept), `packages/app/src/renderer/components/chat/ChatWindow.tsx` (review overlay)
- Verify: manual (renderer is not unit-tested in this repo)

**Interfaces:**
- Consumes: `window.bean.extractMemories`, `window.bean.listMemories`, `window.bean.saveMemories`, `window.bean.onReviewBeforeClose`, `window.bean.allowChatClose` (Task 6); `IPC.reviewBeforeClose`, `IPC.allowChatClose`, `sendToWindow`.
- Produces: two-phase close — first `close` on the chat window is intercepted; the renderer runs extraction + review, then calls `allowChatClose` to let it close.

- [ ] **Step 1: Add the main-process close intercept**

In `packages/app/src/main.ts`, inside `app.whenReady().then(...)`, add near the top of the callback (after `const componentWindows = ...`):

```ts
  let quitting = false;
  app.on("before-quit", () => { quitting = true; });
  const allowClose = new WeakSet<BrowserWindow>();
  ipcMain.on(IPC.allowChatClose, (evt) => {
    const w = BrowserWindow.fromWebContents(evt.sender);
    if (!w) return;
    allowClose.add(w);
    if (!w.isDestroyed()) w.close();
  });
```

Then in `openComponent`, right after `trackComponentWindow(componentWindows, kind, win);`, add:

```ts
    if (kind === "chat") {
      win.on("close", (e) => {
        // First close attempt: hold the window open, let the renderer extract + confirm
        // memories, then re-issue the close via allowChatClose. quitting/allowClose bypass it
        // so app-quit and the second close aren't blocked (safety-window-behavior: chat is its
        // own window, so this never touches avatar/intake).
        if (quitting || allowClose.has(win)) return;
        e.preventDefault();
        sendToWindow(win, IPC.reviewBeforeClose, undefined);
      });
    }
```

- [ ] **Step 2: Add the renderer review overlay**

In `packages/app/src/renderer/components/chat/ChatWindow.tsx`, add imports and a small timeout helper at the top:

```ts
import type { ChatTurn, MemoryCandidate, Memory, RouteSuggestion } from "@bean/core";

const REVIEW_TIMEOUT_MS = 4000;
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
```

Add review state inside `ChatWindow` (next to the other `useState` calls):

```ts
  const [review, setReview] = useState<{ text: string; projectPath?: string; checked: boolean }[] | null>(null);
```

Register the close-review handler in the existing `useEffect` (the one that calls `window.bean.getModel()` etc.). Because it reads the latest transcript, drive it off `itemsRef`:

```ts
    window.bean.onReviewBeforeClose(() => {
      const transcript: ChatTurn[] = itemsRef.current
        .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
        .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));
      if (transcript.length === 0) { window.bean.allowChatClose(); return; }
      void withTimeout(window.bean.extractMemories(transcript), REVIEW_TIMEOUT_MS, [] as MemoryCandidate[])
        .then((candidates) => {
          if (candidates.length === 0) { window.bean.allowChatClose(); return; }
          setReview(candidates.map((c) => ({ text: c.text, projectPath: c.projectPath, checked: true })));
        })
        .catch(() => window.bean.allowChatClose());
    });
```

Add the confirm/skip actions inside `ChatWindow`:

```ts
  const rememberSelected = async (): Promise<void> => {
    const picked = (review ?? []).filter((r) => r.checked);
    if (picked.length > 0) {
      const existing = await window.bean.listMemories();
      const now = new Date().toISOString();
      const additions: Memory[] = picked.map((r, i) => ({
        id: `${Date.now()}-${i}`,
        text: r.text,
        projectPath: r.projectPath,
        createdAt: now,
      }));
      await window.bean.saveMemories([...existing, ...additions]);
    }
    setReview(null);
    window.bean.allowChatClose();
  };
  const skipReview = (): void => { setReview(null); window.bean.allowChatClose(); };
  const toggleReview = (idx: number): void =>
    setReview((prev) => prev?.map((r, i) => (i === idx ? { ...r, checked: !r.checked } : r)) ?? null);
```

Render the overlay as the first child inside the returned `<div class="bean-dashboard bean-chat-window">`, before `<ChatPanel .../>`:

```tsx
      {review ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Before I go — remember these?</div>
            {review.map((r, i) => (
              <label key={i} class="bean-memory-review-row">
                <input type="checkbox" checked={r.checked} onChange={() => toggleReview(i)} />
                <span>{r.text}{r.projectPath ? <em class="bean-memory-review-tag"> · project</em> : null}</span>
              </label>
            ))}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void rememberSelected()}>Remember</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={skipReview}>Skip</button>
            </div>
          </div>
        </div>
      ) : null}
```

Add minimal styles to `packages/app/src/renderer/shared.css` (append at end):

```css
.bean-memory-review { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.35); z-index: 10; }
.bean-memory-review-card { background: var(--bean-surface, #fff); border-radius: 12px; padding: 16px; width: 88%; max-width: 380px; box-shadow: 0 8px 30px rgba(0,0,0,0.25); }
.bean-memory-review-title { font-weight: 600; margin-bottom: 10px; }
.bean-memory-review-row { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; font-size: 13px; }
.bean-memory-review-tag { opacity: 0.6; font-style: normal; }
```

(If `--bean-surface` isn't defined in `theme.css`, use the surface variable that the chat bubbles already use — grep `theme.css` for the panel background token and substitute it.)

- [ ] **Step 3: Build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: exit 0 (esbuild bundles the renderer; tsc validates the new bridge usage).

- [ ] **Step 4: Manual verification**

Run: `pnpm dev`. Then:
1. Double-click the avatar → chat → say "I always use pnpm and prefer terse commit messages." Wait for Bean's reply.
2. Close the chat window. Expected: a "Before I go — remember these?" card appears with at least one checked candidate.
3. Click **Remember**. The window closes. Confirm `~/.bean/memory.json` now contains the fact(s).
4. Reopen chat, ask "what do you know about how I work?" Expected: Bean references the remembered preference (recall works).
5. Open chat, send nothing, close it. Expected: it closes immediately with no review card (empty transcript short-circuits).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/main.ts packages/app/src/renderer/components/chat/ChatWindow.tsx packages/app/src/renderer/shared.css
git commit -m "feat(app): confirm-at-close memory review on the chat window"
```

---

### Task 8: Persona panel memory section

**Files:**
- Modify: `packages/app/src/renderer/components/persona/PersonaPanel.tsx`, `packages/app/src/renderer/shared.css`
- Verify: manual

**Interfaces:**
- Consumes: `window.bean.listMemories`, `window.bean.saveMemories`, `window.bean.listProjects` (Task 6); `Memory`, `Project`.
- Produces: a Memory block below the persona editor — view/edit/delete/add of global and per-project memories, persisted via `saveMemories`.

- [ ] **Step 1: Add memory state + load**

In `packages/app/src/renderer/components/persona/PersonaPanel.tsx`, add imports:

```ts
import type { Memory, Project } from "@bean/core";
```

Add state inside `PersonaPanel` (with the other `useState`):

```ts
  const [memories, setMemories] = useState<Memory[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memError, setMemError] = useState<string | undefined>(undefined);
```

Extend the existing `refresh` to also load memories and projects:

```ts
  const refresh = async (): Promise<void> => {
    const [p, mem, projs] = await Promise.all([
      window.bean.getPersona(),
      window.bean.listMemories(),
      window.bean.listProjects(),
    ]);
    setPersona(p);
    setMemories(mem);
    setProjects(projs);
  };
```

- [ ] **Step 2: Add memory mutators**

Add inside `PersonaPanel`:

```ts
  const persist = async (next: Memory[]): Promise<void> => {
    setMemories(next);
    try { await window.bean.saveMemories(next); setMemError(undefined); }
    catch (err) { setMemError(err instanceof Error ? err.message : String(err)); }
  };
  const editMemory = (id: string, text: string): void =>
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
  const commitMemories = (): void => { void persist(memories); };
  const deleteMemory = (id: string): void => { void persist(memories.filter((m) => m.id !== id)); };
  const addMemory = (projectPath?: string): void => {
    const entry: Memory = { id: `${Date.now()}`, text: "", projectPath, createdAt: new Date().toISOString() };
    void persist([...memories, entry]);
  };
  const nameFor = (path: string): string => projects.find((p) => p.path === path)?.name ?? path;
```

- [ ] **Step 3: Render the memory section**

Insert this block just before the final closing `</div>` of the returned `bean-persona` container (after the `bean-card-actions` block):

```tsx
      <div class="bean-persona-label">MEMORY</div>
      {memError ? <div class="bean-persona-error">Save failed: {memError}</div> : null}

      <div class="bean-memory-group-label">About you</div>
      {memories.filter((m) => !m.projectPath).length === 0 ? (
        <div class="bean-memory-empty">Nothing yet.</div>
      ) : (
        memories.filter((m) => !m.projectPath).map((m) => (
          <div key={m.id} class="bean-memory-item">
            <input
              class="bean-input bean-memory-input"
              value={m.text}
              onInput={(e) => editMemory(m.id, (e.target as HTMLInputElement).value)}
              onBlur={commitMemories}
            />
            <button type="button" class="bean-memory-del" onClick={() => deleteMemory(m.id)} aria-label="Delete">×</button>
          </div>
        ))
      )}
      <button type="button" class="bean-btn bean-btn--ghost" onClick={() => addMemory(undefined)}>+ Add about you</button>

      {projects.filter((p) => memories.some((m) => m.projectPath === p.path)).map((p) => (
        <div key={p.path}>
          <div class="bean-memory-group-label">{p.name}</div>
          {memories.filter((m) => m.projectPath === p.path).map((m) => (
            <div key={m.id} class="bean-memory-item">
              <input
                class="bean-input bean-memory-input"
                value={m.text}
                onInput={(e) => editMemory(m.id, (e.target as HTMLInputElement).value)}
                onBlur={commitMemories}
              />
              <button type="button" class="bean-memory-del" onClick={() => deleteMemory(m.id)} aria-label="Delete">×</button>
            </div>
          ))}
        </div>
      ))}
```

Append styles to `packages/app/src/renderer/shared.css`:

```css
.bean-memory-group-label { font-size: 11px; text-transform: uppercase; opacity: 0.6; margin: 10px 0 4px; }
.bean-memory-empty { font-size: 13px; opacity: 0.6; padding: 2px 0 6px; }
.bean-memory-item { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.bean-memory-input { flex: 1; }
.bean-memory-del { border: none; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; opacity: 0.6; }
.bean-memory-del:hover { opacity: 1; }
```

Note on `nameFor`: it is defined for reuse/consistency with the group headers; the group headers above already use `p.name` directly, so `nameFor` may be unused — if `tsc` flags it under `noUnusedLocals`, delete the `nameFor` line.

- [ ] **Step 4: Build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Manual verification**

Run: `pnpm dev`. Right-click avatar → Persona. Expected:
1. Under **MEMORY → About you**, any global memories from Task 7 appear and are editable; edits persist after blur (reopen the panel to confirm).
2. **+ Add about you** creates a blank editable row; typing + blur writes it to `~/.bean/memory.json`.
3. Memories tagged to a project appear grouped under that project's name.
4. **×** removes a memory and persists the removal.

- [ ] **Step 6: Full gate + commit**

Run: `pnpm test && pnpm typecheck`
Expected: exit 0.

```bash
git add packages/app/src/renderer/components/persona/PersonaPanel.tsx packages/app/src/renderer/shared.css
git commit -m "feat(app): editable memory section in the persona panel"
```

---

### Task 9: Update team memory (`.memory/`)

**Files:**
- Create: `.memory/project-bean-memory.md`
- Modify: `.memory/INDEX.md`

Per `AGENTS.md` memory protocol, record the durable facts about this subsystem in the same change.

- [ ] **Step 1: Write the entry**

Create `.memory/project-bean-memory.md`:

```markdown
# Bean's memory subsystem

`~/.bean/memory.json` holds a curated `Memory[]` (`{ id, text, projectPath?, createdAt }`,
`core/src/memory.ts`). Global entries have no `projectPath`; project ones carry a registered
project's path (model-tagged during extraction, enum-constrained so it can't be invented).

- **Extract:** `extractMemories()` (`memory-extract.ts`) runs a `remember`-tool pass over a
  finished transcript; strict "durable facts only" prompt; dedups against existing; never throws.
- **Recall:** `converse()` takes a `memories` param and injects a "What you remember:" block
  after the catalog. The whole (small, curated) set is injected — no retrieval step.
- **Enabled-skills filter** lives in `buildChatHandler` (app `ipc.ts`), not in `converse()`.
- **Confirm-at-close:** main intercepts the chat window's `close` (guarded by `quitting` +
  an `allowClose` WeakSet), sends `reviewBeforeClose`; the renderer extracts (4s timeout),
  shows a review card, then calls `allowChatClose` to re-issue the close. Empty transcript or
  no candidates closes immediately.
- **Edit surface:** the persona panel's MEMORY section (list/edit/delete/add), persisted via
  `saveMemories`.

Design spec: `docs/superpowers/specs/2026-07-03-bean-memory-design.md`.
```

- [ ] **Step 2: Link it from the index**

In `.memory/INDEX.md`, under the `## project — ongoing work context` list, add:

```markdown
- [project-bean-memory.md](project-bean-memory.md) — Bean's memory: `~/.bean/memory.json`, extract-on-close (confirm), recall-into-converse, enabled-skill filter, persona-panel editing.
```

- [ ] **Step 3: Commit**

```bash
git add .memory/project-bean-memory.md .memory/INDEX.md
git commit -m "docs(memory): record Bean's memory subsystem in team memory"
```

---

## Self-Review

**Spec coverage:**
- Layered global + per-project memory → Tasks 1–2 (`projectPath?` field, central store). ✓
- Extract-on-close, selective/critical → Task 3 (`extractMemories`, strict prompt) + Task 7 (close trigger). ✓
- Confirm-at-close → Task 7 (main intercept + renderer review card, 4s timeout, empty short-circuit). ✓
- Recall-on-open, inject-all curated → Task 4 (`memoriesBlock`) + Task 5 (handler loads memories). ✓
- Skill-aware orchestrator (enabled only) → Task 5 (`enabled !== false` filter feeds catalog + enum). ✓
- Central, model-tagged storage → Task 2 (`~/.bean/memory.json`) + Task 3 (enum-constrained `projectPath`). ✓
- Editable in persona panel → Task 8. ✓
- IPC/channels/preload/bridge → Task 6. ✓
- Team memory update → Task 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one flagged ambiguity (`--bean-surface` token / `nameFor` possibly unused) has an explicit resolution instruction. ✓

**Type consistency:** `Memory { id, text, projectPath?, createdAt }` and `MemoryCandidate { text, projectPath? }` are used identically across Tasks 1–8. `converse(... persona, memories, deps, droppedUrl?)` signature is defined in Task 4 and consumed with that exact argument order in Task 5. `buildMemoryHandlers` deps/return shape matches its Task 6 test. Channel keys (`listMemories`, `saveMemories`, `extractMemories`, `reviewBeforeClose`, `allowChatClose`) are defined once in Task 6 and referenced by preload/main/renderer consistently. ✓
