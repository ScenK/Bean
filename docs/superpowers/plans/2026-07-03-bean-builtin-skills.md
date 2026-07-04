# Built-in Skills (project `.bean` extended by user `~/.bean`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship default ("built-in") skills and a default persona with the Bean repo itself at `<repo-root>/.bean`, with the user's existing `~/.bean` overriding/extending them by filename — writes (save/delete/enable-toggle) still only ever touch `~/.bean`.

**Architecture:** Two new pure functions in `@bean/core` — `projectBeanDir()` (locates `<repo-root>/.bean` relative to `config.ts`'s own compiled location) and `loadLayeredSkills(projectDir, userDir)` (merges two `loadSkills()` calls by filename, user wins, tags each `Skill` with `source: "project" | "user"`) — plus a second optional `fallbackFile` argument on the existing `loadPersona()`. `packages/app` wires both project-root paths alongside the existing user paths through `ipc.ts` and `main.ts`. The Skills panel UI shows a "Built-in" badge and disables Delete for un-forked built-ins.

**Tech Stack:** TypeScript, Node `node:fs/promises` + `node:url`, Vitest, Electron IPC, Preact. No new dependencies.

## Global Constraints

- Node ≥24, pnpm workspace — build/test via `pnpm build` / `pnpm test` / `pnpm typecheck` (turbo).
- Validation gate: `pnpm test && pnpm typecheck` must both exit 0 before calling any task done.
- `@bean/core` stays pure/dependency-injected and Electron-free (see `.memory/convention-core-is-electron-free.md`) — no Electron APIs in `packages/core`.
- Exactly two fixed layers (project, user) — no N-layer/plugin system.
- Writes (`saveSkill`, `deleteSkill`, `savePersona`) always target the user dir/file only — never the project-root built-ins.
- No new npm dependencies for any part of this change.
- Files: kebab-case, ESM with `.js` extensions in relative imports, `import type` for type-only imports (per `AGENTS.md` Code Style).

---

### Task 1: `projectBeanDir()` — locate the repo-root `.bean` dir

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Produces: `projectBeanDir(): string` — returns `<repo-root>/.bean`, the repo-root counterpart to the existing `beanDir()`.
- Consumes: nothing new (uses `node:path`'s `dirname`/`join`, already imported, plus `node:url`'s `fileURLToPath`).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/__test__/config.test.ts` (extend the existing import list and add a new test):

```ts
import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, skillsDir, projectsFile, configFile, personaFile, projectBeanDir } from "../src/config.js";
```

```ts
test("projectBeanDir resolves to <repo-root>/.bean", () => {
  // This test file lives at packages/core/__test__/config.test.ts, a sibling of src/ and dist/
  // under packages/core — three directories up from any of the three reaches the repo root.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  expect(projectBeanDir()).toBe(join(repoRoot, ".bean"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: FAIL — `projectBeanDir` is not exported / not a function.

- [ ] **Step 3: Implement `projectBeanDir()`**

In `packages/core/src/config.ts`, add the `node:url` import and the new function right after `beanDir()`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BeanConfig } from "./types.js";

export function beanDir(): string {
  return join(homedir(), ".bean");
}
// The repo-shipped counterpart to beanDir(): built-in skills/persona that ~/.bean extends.
// This file compiles flat to packages/core/{src,dist}/config.{ts,js} (rootDir: src, outDir:
// dist, no subfolders), so three directories up from here reaches the repo root identically
// whether running from source (vitest) or the built dist/ output.
export function projectBeanDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", ".bean");
}
export function skillsDir(dir: string): string { return join(dir, "skills"); }
export function projectsFile(dir: string): string { return join(dir, "projects.json"); }
export function configFile(dir: string): string { return join(dir, "config.json"); }
export function personaFile(dir: string): string { return join(dir, "persona.json"); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/__test__/config.test.ts
git commit -m "feat(core): add projectBeanDir() for the repo-root built-in .bean dir"
```

---

### Task 2: `loadLayeredSkills()` — merge project + user skills, tag `source`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/skill-library.ts`
- Test: `packages/core/__test__/skill-library.test.ts`

**Interfaces:**
- Consumes: `loadSkills(dir: string): Promise<Skill[]>` (existing, unchanged).
- Produces: `loadLayeredSkills(projectDir: string, userDir: string): Promise<Skill[]>`; `Skill.source?: "project" | "user"`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/skill-library.test.ts` (extend the import and add a second pair of temp dirs + tests):

```ts
import { loadSkills, loadLayeredSkills, saveSkill, deleteSkill, setFrontmatter } from "../src/skill-library.js";
```

```ts
let projectDir: string;
let userDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "bean-skills-project-"));
  userDir = await mkdtemp(join(tmpdir(), "bean-skills-user-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

test("loadLayeredSkills: user overrides project by name", async () => {
  await writeFile(join(projectDir, "a.md"), "OLD");
  await writeFile(join(userDir, "a.md"), "NEW");
  const skills = await loadLayeredSkills(projectDir, userDir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.body).toBe("NEW");
  expect(skills[0]!.source).toBe("user");
});

test("loadLayeredSkills: non-colliding names from both dirs are unioned", async () => {
  await writeFile(join(projectDir, "a.md"), "project body");
  await writeFile(join(userDir, "b.md"), "user body");
  const skills = await loadLayeredSkills(projectDir, userDir);
  expect(skills.map((s) => s.name)).toEqual(["a", "b"]);
  expect(skills[0]!.source).toBe("project");
  expect(skills[1]!.source).toBe("user");
});

test("loadLayeredSkills: missing project dir behaves like today (user skills only)", async () => {
  await writeFile(join(userDir, "b.md"), "user body");
  const skills = await loadLayeredSkills(join(projectDir, "nope"), userDir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("b");
  expect(skills[0]!.source).toBe("user");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/skill-library.test.ts`
Expected: FAIL — `loadLayeredSkills` is not exported / not a function.

- [ ] **Step 3: Add `Skill.source` to the type**

In `packages/core/src/types.ts`, extend the `Skill` interface:

```ts
export interface Skill {
  /** Stable id derived from filename without extension, e.g. "review-code". */
  name: string;
  /** Short description the router reads to choose a skill. */
  description: string;
  /** Full markdown body used to compose the prompt. */
  body: string;
  /** `enabled: false` frontmatter hides the skill from the drag quick-launch. Absent = shown. */
  enabled?: boolean;
  /** Which layer's copy is currently in effect — set only by loadLayeredSkills(). Absent when
   * loaded via plain loadSkills() from a single dir. */
  source?: "project" | "user";
}
```

- [ ] **Step 4: Implement `loadLayeredSkills()`**

In `packages/core/src/skill-library.ts`, add after `loadSkills`:

```ts
// Merges the repo-shipped built-in skills (projectDir) with the user's ~/.bean/skills
// (userDir): a user file with the same name replaces the project one; anything present in
// only one dir still shows up. Tags each result with which layer is currently in effect.
export async function loadLayeredSkills(projectDir: string, userDir: string): Promise<Skill[]> {
  const [projectSkills, userSkills] = await Promise.all([loadSkills(projectDir), loadSkills(userDir)]);
  const byName = new Map<string, Skill>();
  for (const s of projectSkills) byName.set(s.name, { ...s, source: "project" });
  for (const s of userSkills) byName.set(s.name, { ...s, source: "user" });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/skill-library.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/skill-library.ts packages/core/__test__/skill-library.test.ts
git commit -m "feat(core): add loadLayeredSkills() merging project + user skill dirs"
```

---

### Task 3: `loadPersona()` fallback file

**Files:**
- Modify: `packages/core/src/persona-store.ts`
- Test: `packages/core/__test__/persona-store.test.ts`

**Interfaces:**
- Produces: `loadPersona(file: string, fallbackFile?: string): Promise<Persona>` (backward compatible — single-arg calls behave exactly as before).
- Consumes: `isValidPersona`, `DEFAULT_PERSONA` (existing, from `./persona.js`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/persona-store.test.ts`:

```ts
test("falls back to the project persona file when the user file is missing", async () => {
  const userFile = join(dir, "persona.json");
  const projectFile = join(dir, "project-persona.json");
  const projectPersona: Persona = { name: "Builtin", tags: ["Formal"] };
  await writeFile(projectFile, JSON.stringify(projectPersona));
  expect(await loadPersona(userFile, projectFile)).toEqual(projectPersona);
});

test("user file wins over the project file when both exist", async () => {
  const userFile = join(dir, "persona.json");
  const projectFile = join(dir, "project-persona.json");
  const userPersona: Persona = { name: "Mine", tags: ["Playful"] };
  await writeFile(userFile, JSON.stringify(userPersona));
  await writeFile(projectFile, JSON.stringify({ name: "Builtin", tags: ["Formal"] }));
  expect(await loadPersona(userFile, projectFile)).toEqual(userPersona);
});

test("invalid user JSON falls back to the project file", async () => {
  const userFile = join(dir, "persona.json");
  const projectFile = join(dir, "project-persona.json");
  const projectPersona: Persona = { name: "Builtin", tags: ["Formal"] };
  await writeFile(userFile, "{ not json");
  await writeFile(projectFile, JSON.stringify(projectPersona));
  expect(await loadPersona(userFile, projectFile)).toEqual(projectPersona);
});

test("falls back to DEFAULT_PERSONA when neither file exists", async () => {
  expect(await loadPersona(join(dir, "nope.json"), join(dir, "also-nope.json"))).toEqual(DEFAULT_PERSONA);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/persona-store.test.ts`
Expected: FAIL — the new fallback tests get the wrong (default) persona back instead of the project one, since `loadPersona` doesn't accept/use a second argument yet.

- [ ] **Step 3: Implement the fallback**

Replace `loadPersona` in `packages/core/src/persona-store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PERSONA, isValidPersona, type Persona } from "./persona.js";

async function tryReadPersona(file: string): Promise<Persona | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return isValidPersona(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function loadPersona(file: string, fallbackFile?: string): Promise<Persona> {
  return (
    (await tryReadPersona(file)) ??
    (fallbackFile ? await tryReadPersona(fallbackFile) : undefined) ??
    DEFAULT_PERSONA
  );
}

export async function savePersona(file: string, persona: Persona): Promise<void> {
  if (!isValidPersona(persona)) throw new Error("invalid persona: name and at least one tag are required");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(persona, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/persona-store.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — confirms the single-arg call sites are unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/persona-store.ts packages/core/__test__/persona-store.test.ts
git commit -m "feat(core): loadPersona() falls back to a project persona file"
```

---

### Task 4: Seed the repo-root `.bean/skills/` with the initial built-ins

**Files:**
- Create: `.bean/skills/code-review.md`, `.bean/skills/scaffold-feature.md`, `.bean/skills/triage-issues.md`, `.bean/skills/write-tests.md`
- Test: `packages/core/__test__/builtin-skills.test.ts` (new file)

**Interfaces:**
- Consumes: `projectBeanDir()` (Task 1), `skillsDir()` (existing), `loadSkills()` (existing).

- [ ] **Step 1: Copy the four skills from `~/.bean/skills` into the repo**

```bash
mkdir -p /Users/scenkang/Develop/Bean/.bean/skills
cp ~/.bean/skills/code-review.md ~/.bean/skills/scaffold-feature.md ~/.bean/skills/triage-issues.md ~/.bean/skills/write-tests.md /Users/scenkang/Develop/Bean/.bean/skills/
```

- [ ] **Step 2: Write the integration test**

Create `packages/core/__test__/builtin-skills.test.ts`:

```ts
import { expect, test } from "vitest";
import { projectBeanDir, skillsDir } from "../src/config.js";
import { loadSkills } from "../src/skill-library.js";

test("ships four built-in skills at <repo-root>/.bean/skills", async () => {
  const skills = await loadSkills(skillsDir(projectBeanDir()));
  expect(skills.map((s) => s.name).sort()).toEqual([
    "code-review", "scaffold-feature", "triage-issues", "write-tests",
  ]);
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/builtin-skills.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add .bean/skills packages/core/__test__/builtin-skills.test.ts
git commit -m "feat: seed the repo-root .bean/skills built-ins"
```

---

### Task 5: Wire `ipc.ts` for layered skills + persona

**Files:**
- Modify: `packages/app/src/ipc.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `loadLayeredSkills(projectDir, userDir)` (Task 2), `loadPersona(userFile, projectFile)` (Task 3).
- Produces: `RouteHandlerDeps.projectSkillsDir: string`, `ChatHandlerDeps.projectSkillsDir: string` + `.projectPersonaFile: string`, `ListSkillsHandlerDeps.projectSkillsDir: string`, `PersonaHandlerDeps.projectPersonaFile: string`, `RegisterDeps.projectPersonaFile: string` (all new required fields, alongside existing ones). `SaveSkillHandlerDeps`/`DeleteSkillHandlerDeps` are untouched.

- [ ] **Step 1: Update the reading-side interfaces and handler bodies in `ipc.ts`**

Replace the four blocks in `packages/app/src/ipc.ts`:

```ts
export interface RouteHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  chat: RouterDeps["chat"];
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
}

export function buildRouteHandler(deps: RouteHandlerDeps) {
  return async (input: RouteInput): Promise<RouteSuggestion> => {
    const [skills, projects] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
    ]);
    return route(input, skills, projects, { chat: deps.chat, model: deps.getModel() });
  };
}

export interface ChatHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
  personaFile: string;
  projectPersonaFile: string;
}

export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects, persona] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
    ]);
    return converse(req.history, req.message, skills, projects, persona, { chat: deps.converse, model: deps.getModel() }, req.droppedUrl);
  };
}

export interface ListSkillsHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectSkillsDir: string;
  skillsDir: string;
}

export function buildListSkillsHandler(deps: ListSkillsHandlerDeps) {
  return (): Promise<Skill[]> => deps.loadSkills(deps.projectSkillsDir, deps.skillsDir);
}
```

Leave `ListProjectsHandlerDeps`, `SaveProjectsHandlerDeps`, `SaveSkillHandlerDeps`, `DeleteSkillHandlerDeps`, `LaunchHandlerDeps` exactly as they are.

Replace `PersonaHandlerDeps`/`buildPersonaHandlers`:

```ts
export interface PersonaHandlerDeps {
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
}

export function buildPersonaHandlers(deps: PersonaHandlerDeps) {
  return {
    get: (): Promise<Persona> => deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
    save: (persona: Persona): Promise<void> => deps.savePersona(deps.personaFile, persona),
  };
}
```

Add `projectPersonaFile: string;` to `RegisterDeps` (right after `personaFile: string;`):

```ts
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  deleteSkill: (dir: string, name: string) => Promise<void>;
  saveProjects: (file: string, projects: Project[]) => Promise<void>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
  broadcast: (channel: string, payload: unknown) => void;
  openComponent: (kind: ComponentKind, droppedUrl?: string) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  getPendingPlan: () => RouteSuggestion | undefined;
  planFromDrop: (skillName: string, droppedUrl: string) => void;
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
  getAppInfo: () => AppInfo;
  spawnLaunch?: LaunchSpawnFn;
}
```

- [ ] **Step 2: Update `ipc.test.ts` call sites**

In `packages/app/__test__/ipc.test.ts`:

Route handler test (around line 16-23) — add `projectSkillsDir`:

```ts
  const handler = buildRouteHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    chat: async () => JSON.stringify({ skillName: "review-code", projectPath: "/dev/acme", confidence: 0.7 }),
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
  });
```

Chat handler test (around line 44-59) — add `projectSkillsDir` and `projectPersonaFile`:

```ts
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
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
  });
```

`listSkills` handler test (around line 67-74) — assert both dirs are forwarded in the right order:

```ts
test("listSkills handler loads skills from both the project and user skills dirs", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const handler = buildListSkillsHandler({
    loadSkills: async (projectDir, userDir) => {
      expect(projectDir).toBe("/b/project-skills");
      expect(userDir).toBe("/b/skills");
      return skills;
    },
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
  });
  expect(await handler()).toBe(skills);
});
```

`getPersona` handler test (around line 107-115):

```ts
test("getPersona handler loads persona from the user file, falling back to the project file", async () => {
  const persona: Persona = { name: "Bean", tags: ["Warm"] };
  const handlers = buildPersonaHandlers({
    loadPersona: async (userFile, projectFile) => {
      expect(userFile).toBe("/b/persona.json");
      expect(projectFile).toBe("/b/project-persona.json");
      return persona;
    },
    savePersona: async () => {},
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
  });
  expect(await handlers.get()).toBe(persona);
});
```

`savePersona` handler test (around line 117-127) — add `projectPersonaFile` to satisfy the interface:

```ts
test("savePersona handler writes through the injected deps with the configured persona file", async () => {
  const persona: Persona = { name: "Bean", tags: ["Warm"] };
  const savePersona = vi.fn(async () => {});
  const handlers = buildPersonaHandlers({
    loadPersona: async () => persona,
    savePersona,
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
  });
  await handlers.save(persona);
  expect(savePersona).toHaveBeenCalledWith("/b/persona.json", persona);
});
```

- [ ] **Step 3: Run the test file to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): wire ipc.ts for layered project+user skills and persona"
```

---

### Task 6: Wire `main.ts`

**Files:**
- Modify: `packages/app/src/main.ts`

**Interfaces:**
- Consumes: `projectBeanDir()` (Task 1), `loadLayeredSkills` (Task 2), `loadPersona(userFile, projectFile)` (Task 3), the updated `registerIpc` deps shape (Task 5).

- [ ] **Step 1: Update the import list**

In `packages/app/src/main.ts`, replace the `@bean/core` import:

```ts
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile, projectBeanDir,
  loadConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona, saveConfig,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill,
} from "@bean/core";
```

- [ ] **Step 2: Compute `projectDir` alongside `dir`**

Inside `app.whenReady().then(async () => {`, right after `const dir = beanDir();`:

```ts
  const dir = beanDir();
  const projectDir = projectBeanDir();
```

- [ ] **Step 3: Update `planFromDrop` to read the layered skills**

```ts
  const planFromDrop = (skillName: string, droppedUrl: string): void => {
    void (async () => {
      const [skills, projects] = await Promise.all([
        loadLayeredSkills(skillsDir(projectDir), skillsDir(dir)),
        loadProjects(projectsFile(dir)),
      ]);
      const suggestion = planForDroppedSkill(skillName, droppedUrl, skills, projects);
      planStore.set(suggestion);
      openComponent("plan");
      sendWhenReady(componentWindows.get("plan")!, IPC.proposeRun, suggestion);
    })();
  };
```

- [ ] **Step 4: Update the `registerIpc` call**

```ts
    registerIpc(ipcMain, {
      loadSkills: loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona,
      chat: runtime.chat,
      converse: runtime.converse,
      getModel: runtime.getModel,
      projectSkillsDir: skillsDir(projectDir),
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      personaFile: personaFile(dir),
      projectPersonaFile: personaFile(projectDir),
      getConfig: () => ({
        openaiApiKey: runtime.getApiKey(),
        model: runtime.getModel(),
        paths: {
          config: configFile(dir),
          skills: skillsDir(dir),
          projects: projectsFile(dir),
          persona: personaFile(dir),
        },
      }),
      applyConfig: (update) => runtime.apply(update),
      getAppInfo: () => ({
        version: app.getVersion(),
        author: "Scen.K",
        description: "Bean routes a loose instruction to one of your skills and projects, then runs it with opencode.",
      }),
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun, planFromDrop,
      getPendingPlan: planStore.get,
    });
```

(`getConfig().paths` is left pointing at the user dir only, matching its existing meaning — it's the "where does Bean write your stuff" view already shown elsewhere.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: no errors. (`main.ts` has no dedicated unit test today — same as before this change — so typecheck plus Task 5's `ipc.test.ts` are the coverage for this wiring.)

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/main.ts
git commit -m "feat(app): wire main.ts to load layered project+user skills and persona"
```

---

### Task 7: Skills panel UI — built-in badge, disabled delete, path hint

**Files:**
- Modify: `packages/app/src/renderer/components/skills/SkillsPanel.tsx`

**Interfaces:**
- Consumes: `Skill.source` (Task 2). Reuses the existing `.bean-chip` CSS class already used for project-assignment chips — no new CSS.

- [ ] **Step 1: Add the "Built-in" badge next to the skill title**

In `packages/app/src/renderer/components/skills/SkillsPanel.tsx`, replace:

```tsx
            <div class="bean-skills-title">{selectedSkill.name}</div>
```

with:

```tsx
            <div class="bean-skills-title">
              {selectedSkill.name}
              {selectedSkill.source === "project" ? (
                <span class="bean-chip" style="margin-left:8px">Built-in</span>
              ) : null}
            </div>
```

- [ ] **Step 2: Disable Delete for un-forked built-ins**

Replace:

```tsx
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void deleteSkill()}>
                Delete
              </button>
```

with:

```tsx
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={selectedSkill.source === "project"}
                title={selectedSkill.source === "project" ? "Built-in skill — edit it to make your own copy, then you can delete that copy" : undefined}
                onClick={() => void deleteSkill()}
              >
                Delete
              </button>
```

- [ ] **Step 3: Update the footer path hint**

Replace:

```tsx
        <div class="bean-skills-path">~/.bean/skills/*.md</div>
```

with:

```tsx
        <div class="bean-skills-path">.bean/skills/*.md (built-in) + ~/.bean/skills/*.md (yours, wins)</div>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: no errors. (No component-test infra exists in this repo for `.tsx` files today — same as every other panel component — so typecheck is the verification, consistent with existing conventions.)

- [ ] **Step 5: Full repo verification**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across every package.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/renderer/components/skills/SkillsPanel.tsx
git commit -m "feat(app): show built-in badge and guard delete in the Skills panel"
```
