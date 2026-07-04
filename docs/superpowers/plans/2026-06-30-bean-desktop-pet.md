# Bean Desktop Pet Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP of Bean — a floating desktop avatar that routes loose input (instruction + dropped URL) to a skill + project, confirms, then runs `opencode` and streams output.

**Architecture:** pnpm + Turbo monorepo. A pure-logic `core` package (Router, Runner, SkillLibrary, ProjectRegistry, Config — zero Electron deps, fully unit-tested with Vitest) and a thin Electron `app` package wiring `core` to three windows (Avatar, Intake, Console). OpenAI is used only as a router; the real reasoning runs in `opencode` subprocesses.

**Tech Stack:** Node 24, TypeScript (strict, latest), ESBuild (latest), pnpm 11, Turbo (latest), Vitest (latest), Electron (latest), OpenAI SDK (latest).

## Global Constraints

- Node 24; pnpm workspaces; Turbo orchestration; monorepo.
- Latest version of every dependency (TypeScript, ESBuild, Electron, Vitest, OpenAI SDK, Turbo).
- TypeScript strict mode everywhere.
- Tests live in `__test__/` folders, NOT co-located with source.
- `core` has zero Electron imports.
- opencode invocation: `opencode run "<prompt>" --dir <projectPath>` (message is positional; `--dir` sets project dir; `-p` is `--password`, never the prompt).
- Skill → run delivery is inline prompt composition (no files written into target projects).
- One run at a time for v1. Router output is always a confirmable, editable suggestion — never auto-fired.
- All Bean data under `~/.bean/` (`skills/*.md`, `projects.json`, `config.json`); never committed.
- Frequent commits: one per task minimum.

---

## File Structure

```
bean/
  package.json                       # workspace root + turbo scripts
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  .gitignore
  packages/
    core/
      package.json
      tsconfig.json
      vitest.config.ts
      src/
        types.ts                     # shared domain types
        config.ts                    # Config: load/validate ~/.bean/config.json
        skill-library.ts             # SkillLibrary: read+parse ~/.bean/skills/*.md
        project-registry.ts          # ProjectRegistry: read/write projects.json
        prompt.ts                    # composePrompt(skill, instruction, url)
        router.ts                    # route(input, skills, projects, openai) -> suggestion
        runner.ts                    # run(suggestion, spawnFn) -> streaming + status
        index.ts                     # public barrel exports
      __test__/
        config.test.ts
        skill-library.test.ts
        project-registry.test.ts
        prompt.test.ts
        router.test.ts
        runner.test.ts
    app/
      package.json
      tsconfig.json
      esbuild.config.mjs
      src/
        main.ts                      # Electron entry: windows + IPC wiring
        preload.ts                   # contextBridge IPC surface
        ipc.ts                       # IPC channel names + handler registration
        windows.ts                   # createAvatar/Intake/Console window helpers
        renderer/
          avatar.html / avatar.ts
          intake.html / intake.ts
          console.html / console.ts
      __test__/
        ipc.test.ts                  # IPC handler logic (Electron mocked)
```

---

## Task 1: Monorepo scaffold + tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore` (already exists — verify)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts` (temporary stub), `packages/core/__test__/smoke.test.ts`

**Interfaces:**
- Produces: working `pnpm install`, `pnpm test`, `pnpm build`, `pnpm typecheck` at the root via Turbo.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "bean",
  "private": true,
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 5: Create `packages/core/package.json`**

```json
{
  "name": "@bean/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "openai": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "vitest": "latest",
    "@types/node": "latest"
  }
}
```

- [ ] **Step 6: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 7: Create `packages/core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__test__/**/*.test.ts"],
  },
});
```

- [ ] **Step 8: Create temporary `packages/core/src/index.ts`**

```ts
export const version = "0.0.0";
```

- [ ] **Step 9: Write smoke test `packages/core/__test__/smoke.test.ts`**

```ts
import { expect, test } from "vitest";
import { version } from "../src/index.js";

test("core exports version", () => {
  expect(version).toBe("0.0.0");
});
```

- [ ] **Step 10: Install and verify**

Run: `pnpm install && pnpm test`
Expected: install succeeds; Turbo runs `@bean/core` test; smoke test PASSES.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm+turbo monorepo with core package"
```

---

## Task 2: Domain types

**Files:**
- Create: `packages/core/src/types.ts`
- Test: none (pure type declarations; exercised by later tasks)

**Interfaces:**
- Produces: `Skill`, `Project`, `RouteInput`, `RouteSuggestion`, `BeanConfig`, `RunStatus`, `RunEvent` used by every later task.

- [ ] **Step 1: Write `packages/core/src/types.ts`**

```ts
export interface Skill {
  /** Stable id derived from filename without extension, e.g. "review-code". */
  name: string;
  /** Short description the router reads to choose a skill. */
  description: string;
  /** Full markdown body used to compose the prompt. */
  body: string;
}

export interface Project {
  name: string;
  path: string;
  defaultSkill?: string;
}

export interface RouteInput {
  userText: string;
  droppedUrl?: string;
}

export interface RouteSuggestion {
  skillName: string;
  projectPath: string;
  composedPrompt: string;
  confidence: number; // 0..1
}

export interface BeanConfig {
  openaiApiKey: string;
  model: string;
  beanDir: string; // resolved absolute path to ~/.bean
}

export type RunStatus = "running" | "done" | "failed";

export type RunEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "status"; status: RunStatus; exitCode?: number; message?: string };
```

- [ ] **Step 2: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bean/core typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): add domain types"
```

---

## Task 3: Prompt composition

**Files:**
- Create: `packages/core/src/prompt.ts`
- Test: `packages/core/__test__/prompt.test.ts`

**Interfaces:**
- Consumes: `Skill` from `types.ts`.
- Produces: `composePrompt(skill: Skill, instruction: string, url?: string): string`.

- [ ] **Step 1: Write failing test `packages/core/__test__/prompt.test.ts`**

```ts
import { expect, test } from "vitest";
import { composePrompt } from "../src/prompt.js";
import type { Skill } from "../src/types.js";

const skill: Skill = {
  name: "review-code",
  description: "Review a merge request",
  body: "# Review\nDo a thorough review.",
};

test("includes skill body and instruction", () => {
  const out = composePrompt(skill, "review MR 42");
  expect(out).toContain("Do a thorough review.");
  expect(out).toContain("review MR 42");
});

test("includes url when provided", () => {
  const out = composePrompt(skill, "look at this", "https://jira/X-1");
  expect(out).toContain("https://jira/X-1");
});

test("omits url section when absent", () => {
  const out = composePrompt(skill, "go");
  expect(out.toLowerCase()).not.toContain("context url");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- prompt`
Expected: FAIL with "composePrompt is not a function" / module not found.

- [ ] **Step 3: Write `packages/core/src/prompt.ts`**

```ts
import type { Skill } from "./types.js";

export function composePrompt(skill: Skill, instruction: string, url?: string): string {
  const parts = [skill.body.trim(), "", `## Task`, instruction.trim()];
  if (url && url.trim()) {
    parts.push("", `## Context URL`, url.trim());
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- prompt`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): compose run prompt from skill + instruction + url"
```

---

## Task 4: SkillLibrary

**Files:**
- Create: `packages/core/src/skill-library.ts`
- Test: `packages/core/__test__/skill-library.test.ts`

**Interfaces:**
- Consumes: `Skill` from `types.ts`.
- Produces: `loadSkills(dir: string): Promise<Skill[]>`. Parses each `*.md`: `name` = filename without `.md`; `description` = value of `description:` frontmatter if present, else the first non-empty line after stripping a leading `#`; `body` = full file text.

- [ ] **Step 1: Write failing test `packages/core/__test__/skill-library.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "../src/skill-library.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-skills-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("parses frontmatter description", async () => {
  await writeFile(join(dir, "review-code.md"), "---\ndescription: Review a MR\n---\n# Review\nbody");
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("review-code");
  expect(skills[0]!.description).toBe("Review a MR");
  expect(skills[0]!.body).toContain("# Review");
});

test("falls back to first heading line for description", async () => {
  await writeFile(join(dir, "investigate.md"), "# Investigate a bug\nsteps...");
  const skills = await loadSkills(dir);
  expect(skills[0]!.description).toBe("Investigate a bug");
});

test("ignores non-md files and returns empty for missing dir", async () => {
  await writeFile(join(dir, "notes.txt"), "nope");
  expect(await loadSkills(join(dir, "nope-dir"))).toEqual([]);
  expect(await loadSkills(dir)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- skill-library`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/core/src/skill-library.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Skill } from "./types.js";

function parseDescription(text: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const line = fm[1]!.split("\n").find((l) => l.startsWith("description:"));
    if (line) return line.slice("description:".length).trim();
  }
  const first = text
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ? first.replace(/^#+\s*/, "") : "";
}

export async function loadSkills(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".md")).sort();
  const skills: Skill[] = [];
  for (const file of files) {
    const body = await readFile(join(dir, file), "utf8");
    skills.push({ name: basename(file, ".md"), description: parseDescription(body), body });
  }
  return skills;
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- skill-library`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): load and parse skill library markdown"
```

---

## Task 5: ProjectRegistry

**Files:**
- Create: `packages/core/src/project-registry.ts`
- Test: `packages/core/__test__/project-registry.test.ts`

**Interfaces:**
- Consumes: `Project` from `types.ts`.
- Produces: `loadProjects(file: string): Promise<Project[]>` (missing file → `[]`); `saveProjects(file: string, projects: Project[]): Promise<void>` (creates parent dir, pretty JSON).

- [ ] **Step 1: Write failing test `packages/core/__test__/project-registry.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjects, saveProjects } from "../src/project-registry.js";
import type { Project } from "../src/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-proj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("missing file returns empty list", async () => {
  expect(await loadProjects(join(dir, "projects.json"))).toEqual([]);
});

test("save then load round-trips", async () => {
  const file = join(dir, "nested", "projects.json");
  const projects: Project[] = [{ name: "acme", path: "/x/acme", defaultSkill: "review-code" }];
  await saveProjects(file, projects);
  expect(await loadProjects(file)).toEqual(projects);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- project-registry`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/core/src/project-registry.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Project } from "./types.js";

export async function loadProjects(file: string): Promise<Project[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Project[]) : [];
  } catch {
    return [];
  }
}

export async function saveProjects(file: string, projects: Project[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(projects, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- project-registry`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): project registry load/save"
```

---

## Task 6: Config

**Files:**
- Create: `packages/core/src/config.ts`
- Test: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Consumes: `BeanConfig` from `types.ts`.
- Produces:
  - `beanDir(): string` → `~/.bean` (uses `os.homedir()`).
  - `skillsDir(dir: string): string`, `projectsFile(dir: string): string`, `configFile(dir: string): string` path helpers.
  - `loadConfig(file: string, beanDirPath: string): Promise<BeanConfig>` → reads json `{ openaiApiKey, model }`; throws `Error("Bean config missing: <file>")` if file absent; defaults `model` to `"gpt-4o-mini"` when not set; sets `beanDir = beanDirPath`.

- [ ] **Step 1: Write failing test `packages/core/__test__/config.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, skillsDir, projectsFile, configFile } from "../src/config.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-cfg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("path helpers", () => {
  expect(skillsDir("/b")).toBe("/b/skills");
  expect(projectsFile("/b")).toBe("/b/projects.json");
  expect(configFile("/b")).toBe("/b/config.json");
});

test("loads config and defaults model", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.openaiApiKey).toBe("sk-x");
  expect(cfg.model).toBe("gpt-4o-mini");
  expect(cfg.beanDir).toBe("/b");
});

test("throws when missing", async () => {
  await expect(loadConfig(join(dir, "nope.json"), "/b")).rejects.toThrow("Bean config missing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- config`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/core/src/config.ts`**

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BeanConfig } from "./types.js";

export function beanDir(): string {
  return join(homedir(), ".bean");
}
export function skillsDir(dir: string): string { return join(dir, "skills"); }
export function projectsFile(dir: string): string { return join(dir, "projects.json"); }
export function configFile(dir: string): string { return join(dir, "config.json"); }

export async function loadConfig(file: string, beanDirPath: string): Promise<BeanConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Bean config missing: ${file}`);
  }
  const parsed = JSON.parse(raw) as Partial<BeanConfig>;
  return {
    openaiApiKey: parsed.openaiApiKey ?? "",
    model: parsed.model ?? "gpt-4o-mini",
    beanDir: beanDirPath,
  };
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- config`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): config loading and path helpers"
```

---

## Task 7: Router

**Files:**
- Create: `packages/core/src/router.ts`
- Test: `packages/core/__test__/router.test.ts`

**Interfaces:**
- Consumes: `Skill`, `Project`, `RouteInput`, `RouteSuggestion`, `composePrompt`.
- Produces: `route(input, skills, projects, deps): Promise<RouteSuggestion>` where
  `deps = { chat: (args: { model: string; messages: ChatMsg[] }) => Promise<string>; model: string }`.
  The `chat` function returns the model's raw text (expected JSON `{ skillName, projectPath, confidence }`). Router builds the final `composedPrompt` itself via `composePrompt` (NOT trusting the model to echo the body). On unparseable model output or unknown skill/project name, returns a low-confidence suggestion with best-guess defaults (first project path, project.defaultSkill or first skill) and `confidence: 0`.

This keeps the OpenAI SDK out of `core`'s testable surface — the caller injects `chat`. Wiring the real OpenAI client is done in Task 8.

- [ ] **Step 1: Write failing test `packages/core/__test__/router.test.ts`**

```ts
import { expect, test } from "vitest";
import { route } from "../src/router.js";
import type { Skill, Project } from "../src/types.js";

const skills: Skill[] = [
  { name: "review-code", description: "review", body: "REVIEW BODY" },
  { name: "investigate", description: "investigate", body: "INVESTIGATE BODY" },
];
const projects: Project[] = [
  { name: "acme", path: "/dev/acme", defaultSkill: "review-code" },
  { name: "bean", path: "/dev/bean" },
];

test("uses model choice and composes prompt from local skill body", async () => {
  const chat = async () =>
    JSON.stringify({ skillName: "review-code", projectPath: "/dev/acme", confidence: 0.9 });
  const s = await route(
    { userText: "review this", droppedUrl: "https://jira/X-1" },
    skills, projects, { chat, model: "gpt-4o-mini" },
  );
  expect(s.skillName).toBe("review-code");
  expect(s.projectPath).toBe("/dev/acme");
  expect(s.confidence).toBe(0.9);
  expect(s.composedPrompt).toContain("REVIEW BODY");
  expect(s.composedPrompt).toContain("review this");
  expect(s.composedPrompt).toContain("https://jira/X-1");
});

test("falls back to confidence 0 on garbage model output", async () => {
  const chat = async () => "not json";
  const s = await route({ userText: "x" }, skills, projects, { chat, model: "m" });
  expect(s.confidence).toBe(0);
  expect(s.projectPath).toBe("/dev/acme");
  expect(s.skillName).toBe("review-code");
});

test("falls back when model names unknown skill/project", async () => {
  const chat = async () =>
    JSON.stringify({ skillName: "nope", projectPath: "/nowhere", confidence: 0.8 });
  const s = await route({ userText: "x" }, skills, projects, { chat, model: "m" });
  expect(s.confidence).toBe(0);
  expect(s.projectPath).toBe("/dev/acme");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- router`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/core/src/router.ts`**

```ts
import { composePrompt } from "./prompt.js";
import type { Project, RouteInput, RouteSuggestion, Skill } from "./types.js";

export interface ChatMsg { role: "system" | "user"; content: string; }
export interface RouterDeps {
  chat: (args: { model: string; messages: ChatMsg[] }) => Promise<string>;
  model: string;
}

function buildMessages(input: RouteInput, skills: Skill[], projects: Project[]): ChatMsg[] {
  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const projectList = projects.map((p) => `- ${p.name} (${p.path})`).join("\n");
  return [
    {
      role: "system",
      content:
        "You route a user request to one skill and one project. " +
        "Reply ONLY with JSON: {\"skillName\":string,\"projectPath\":string,\"confidence\":number}. " +
        "skillName must be one of the listed skill names; projectPath must be one of the listed project paths.",
    },
    {
      role: "user",
      content:
        `Skills:\n${skillList}\n\nProjects:\n${projectList}\n\n` +
        `Request: ${input.userText}\n` +
        (input.droppedUrl ? `URL: ${input.droppedUrl}\n` : ""),
    },
  ];
}

export async function route(
  input: RouteInput,
  skills: Skill[],
  projects: Project[],
  deps: RouterDeps,
): Promise<RouteSuggestion> {
  const fallbackProject = projects[0];
  const fallbackSkill =
    skills.find((s) => s.name === fallbackProject?.defaultSkill) ?? skills[0];

  const compose = (skill: Skill | undefined, projectPath: string, confidence: number): RouteSuggestion => ({
    skillName: skill?.name ?? "",
    projectPath,
    composedPrompt: skill ? composePrompt(skill, input.userText, input.droppedUrl) : input.userText,
    confidence,
  });

  let parsed: { skillName?: string; projectPath?: string; confidence?: number };
  try {
    const raw = await deps.chat({ model: deps.model, messages: buildMessages(input, skills, projects) });
    parsed = JSON.parse(raw);
  } catch {
    return compose(fallbackSkill, fallbackProject?.path ?? "", 0);
  }

  const skill = skills.find((s) => s.name === parsed.skillName);
  const project = projects.find((p) => p.path === parsed.projectPath);
  if (!skill || !project) {
    return compose(fallbackSkill, fallbackProject?.path ?? "", 0);
  }
  return compose(skill, project.path, typeof parsed.confidence === "number" ? parsed.confidence : 0);
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
export * from "./router.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- router`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): router maps input to skill+project suggestion"
```

---

## Task 8: OpenAI chat adapter

**Files:**
- Create: `packages/core/src/openai-chat.ts`
- Test: `packages/core/__test__/openai-chat.test.ts`

**Interfaces:**
- Consumes: `RouterDeps["chat"]` shape from `router.ts`.
- Produces: `makeOpenAIChat(apiKey: string): RouterDeps["chat"]` — returns a `chat` fn that calls the OpenAI Chat Completions API and returns the first message's text (`""` if none). Constructed via dependency injection so tests pass a fake client.
- Also: `makeOpenAIChatWithClient(client: ChatClient): RouterDeps["chat"]` where `ChatClient` is the minimal interface actually used, enabling tests without network.

- [ ] **Step 1: Write failing test `packages/core/__test__/openai-chat.test.ts`**

```ts
import { expect, test } from "vitest";
import { makeOpenAIChatWithClient } from "../src/openai-chat.js";

test("returns first choice content", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: "hello" } }] }),
      },
    },
  };
  const chat = makeOpenAIChatWithClient(fakeClient as never);
  const out = await chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  expect(out).toBe("hello");
});

test("returns empty string when no choices", async () => {
  const fakeClient = {
    chat: { completions: { create: async () => ({ choices: [] }) } },
  };
  const chat = makeOpenAIChatWithClient(fakeClient as never);
  expect(await chat({ model: "m", messages: [] })).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- openai-chat`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/core/src/openai-chat.ts`**

```ts
import OpenAI from "openai";
import type { ChatMsg, RouterDeps } from "./router.js";

interface ChatClient {
  chat: {
    completions: {
      create: (args: { model: string; messages: ChatMsg[] }) => Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

export function makeOpenAIChatWithClient(client: ChatClient): RouterDeps["chat"] {
  return async ({ model, messages }) => {
    const res = await client.chat.completions.create({ model, messages });
    return res.choices[0]?.message?.content ?? "";
  };
}

export function makeOpenAIChat(apiKey: string): RouterDeps["chat"] {
  const client = new OpenAI({ apiKey }) as unknown as ChatClient;
  return makeOpenAIChatWithClient(client);
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
export * from "./router.js";
export * from "./openai-chat.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- openai-chat`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): OpenAI chat adapter for router"
```

---

## Task 9: Runner

**Files:**
- Create: `packages/core/src/runner.ts`
- Test: `packages/core/__test__/runner.test.ts`

**Interfaces:**
- Consumes: `RouteSuggestion`, `RunEvent`, `RunStatus`.
- Produces: `runOpencode(suggestion, onEvent, spawnFn?): Promise<RunStatus>`.
  - `spawnFn` defaults to a wrapper over `node:child_process.spawn`, injected for tests.
  - Builds args: `["run", suggestion.composedPrompt, "--dir", suggestion.projectPath]`, command `"opencode"`.
  - Emits `{type:"status",status:"running"}` immediately, streams `stdout`→`{type:"stdout"}`, `stderr`→`{type:"stderr"}`, and on close emits `{type:"status",status: code===0 ? "done":"failed", exitCode}`. On spawn `error` (e.g. ENOENT / missing binary) emits `{type:"status",status:"failed",message}` and resolves `"failed"`.

- [ ] **Step 1: Write failing test `packages/core/__test__/runner.test.ts`**

```ts
import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { runOpencode, type SpawnFn } from "../src/runner.js";
import type { RouteSuggestion, RunEvent } from "../src/types.js";

const suggestion: RouteSuggestion = {
  skillName: "review-code", projectPath: "/dev/acme",
  composedPrompt: "do it", confidence: 1,
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("streams output and resolves done on exit 0", async () => {
  const child = fakeChild();
  let capturedArgs: string[] = [];
  const spawnFn: SpawnFn = (_cmd, args) => { capturedArgs = args; return child as never; };
  const events: RunEvent[] = [];
  const p = runOpencode(suggestion, (e) => events.push(e), spawnFn);
  child.stdout.emit("data", Buffer.from("hello"));
  child.emit("close", 0);
  const status = await p;
  expect(status).toBe("done");
  expect(capturedArgs).toEqual(["run", "do it", "--dir", "/dev/acme"]);
  expect(events).toContainEqual({ type: "stdout", text: "hello" });
  expect(events.at(-1)).toEqual({ type: "status", status: "done", exitCode: 0 });
});

test("resolves failed on non-zero exit", async () => {
  const child = fakeChild();
  const spawnFn: SpawnFn = () => child as never;
  const p = runOpencode(suggestion, () => {}, spawnFn);
  child.emit("close", 2);
  expect(await p).toBe("failed");
});

test("resolves failed on spawn error", async () => {
  const child = fakeChild();
  const spawnFn: SpawnFn = () => child as never;
  const events: RunEvent[] = [];
  const p = runOpencode(suggestion, (e) => events.push(e), spawnFn);
  child.emit("error", new Error("spawn opencode ENOENT"));
  expect(await p).toBe("failed");
  expect(events.at(-1)).toMatchObject({ type: "status", status: "failed" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core test -- runner`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/core/src/runner.ts`**

```ts
import { spawn } from "node:child_process";
import type { RouteSuggestion, RunEvent, RunStatus } from "./types.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string },
) => import("node:child_process").ChildProcess;

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args, options);

export function runOpencode(
  suggestion: RouteSuggestion,
  onEvent: (event: RunEvent) => void,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<RunStatus> {
  return new Promise((resolve) => {
    const args = ["run", suggestion.composedPrompt, "--dir", suggestion.projectPath];
    onEvent({ type: "status", status: "running" });
    const child = spawnFn("opencode", args, { cwd: suggestion.projectPath });

    child.stdout?.on("data", (d: Buffer) => onEvent({ type: "stdout", text: d.toString() }));
    child.stderr?.on("data", (d: Buffer) => onEvent({ type: "stderr", text: d.toString() }));

    let settled = false;
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      onEvent({ type: "status", status: "failed", message: err.message });
      resolve("failed");
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      const status: RunStatus = code === 0 ? "done" : "failed";
      onEvent({ type: "status", status, exitCode: code ?? undefined });
      resolve(status);
    });
  });
}
```

- [ ] **Step 4: Export from barrel — update `packages/core/src/index.ts`**

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
export * from "./router.js";
export * from "./openai-chat.js";
export * from "./runner.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core test -- runner`
Expected: PASS (3 tests).

- [ ] **Step 6: Run full core suite + typecheck**

Run: `pnpm --filter @bean/core test && pnpm --filter @bean/core typecheck`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): opencode runner with streaming and status"
```

---

## Task 10: App package scaffold + Electron entry

**Files:**
- Create: `packages/app/package.json`, `packages/app/tsconfig.json`, `packages/app/esbuild.config.mjs`
- Create: `packages/app/src/main.ts` (minimal: open Avatar window), `packages/app/src/windows.ts`
- Create: `packages/app/src/renderer/avatar.html`, `packages/app/src/renderer/avatar.ts`

**Interfaces:**
- Consumes: `@bean/core` (workspace dep).
- Produces: `createAvatarWindow(): BrowserWindow`, `createIntakeWindow()`, `createConsoleWindow()` in `windows.ts`. A launchable Electron app showing the draggable avatar.

- [ ] **Step 1: Create `packages/app/package.json`**

```json
{
  "name": "@bean/app",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "start": "electron dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@bean/core": "workspace:*"
  },
  "devDependencies": {
    "electron": "latest",
    "esbuild": "latest",
    "typescript": "latest",
    "vitest": "latest",
    "@types/node": "latest"
  }
}
```

- [ ] **Step 2: Create `packages/app/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "types": ["node"]
  },
  "include": ["src", "__test__"]
}
```

- [ ] **Step 3: Create `packages/app/esbuild.config.mjs`**

```js
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const common = { bundle: true, platform: "node", format: "esm", target: "node24",
  external: ["electron"], sourcemap: true };

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" });
await build({ ...common, platform: "browser",
  entryPoints: ["src/renderer/avatar.ts", "src/renderer/intake.ts", "src/renderer/console.ts"],
  outdir: "dist/renderer" });

mkdirSync("dist/renderer", { recursive: true });
for (const f of ["avatar", "intake", "console"]) {
  cpSync(`src/renderer/${f}.html`, `dist/renderer/${f}.html`);
}
```

- [ ] **Step 4: Create `packages/app/src/windows.ts`**

```ts
import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "preload.js");
const renderer = (name: string) => join(here, "renderer", `${name}.html`);

export function createAvatarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 120, height: 120, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false,
    webPreferences: { preload },
  });
  void win.loadFile(renderer("avatar"));
  return win;
}

export function createIntakeWindow(): BrowserWindow {
  const win = new BrowserWindow({ width: 420, height: 220, frame: false, webPreferences: { preload } });
  void win.loadFile(renderer("intake"));
  return win;
}

export function createConsoleWindow(): BrowserWindow {
  const win = new BrowserWindow({ width: 720, height: 520, webPreferences: { preload } });
  void win.loadFile(renderer("console"));
  return win;
}
```

- [ ] **Step 5: Create `packages/app/src/main.ts`**

```ts
import { app } from "electron";
import { createAvatarWindow } from "./windows.js";

app.whenReady().then(() => {
  createAvatarWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 6: Create `packages/app/src/renderer/avatar.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><link rel="stylesheet" href="avatar.css" /></head>
  <body><div id="bean" title="Bean">🫘</div><script type="module" src="avatar.js"></script></body>
</html>
```

- [ ] **Step 7: Create `packages/app/src/renderer/avatar.ts`**

```ts
// Avatar drag region + click handled here; logic added in Task 12.
const el = document.getElementById("bean");
if (el) {
  el.style.fontSize = "72px";
  el.style.cursor = "grab";
  (el.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "drag";
}
```

- [ ] **Step 8: Build and launch manually to verify the avatar appears**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app start`
Expected: a small frameless always-on-top window with a 🫘 appears and is draggable. Close it.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(app): electron scaffold with draggable avatar window"
```

---

## Task 11: IPC surface + preload

**Files:**
- Create: `packages/app/src/ipc.ts`, `packages/app/src/preload.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `@bean/core` (`loadSkills`, `loadProjects`, `loadConfig`, `route`, `makeOpenAIChat`, `runOpencode`, path helpers).
- Produces:
  - Channel constants `IPC = { route: "bean:route", run: "bean:run", runEvent: "bean:run-event" }`.
  - `buildRouteHandler(deps)` — pure-ish function returning `(input: RouteInput) => Promise<RouteSuggestion>`; `deps = { loadSkills, loadProjects, route, chat, model, skillsDir, projectsFile }`. Tested directly with fakes.
  - `registerIpc(ipcMain, deps)` — registers handlers (thin; not unit-tested).
  - Preload exposes `window.bean = { route(input), run(suggestion), onRunEvent(cb) }` via `contextBridge`.

- [ ] **Step 1: Write failing test `packages/app/__test__/ipc.test.ts`**

```ts
import { expect, test } from "vitest";
import { buildRouteHandler } from "../src/ipc.js";
import type { Project, RouteSuggestion, Skill } from "@bean/core";

test("route handler wires core pieces together", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const projects: Project[] = [{ name: "acme", path: "/dev/acme" }];
  const handler = buildRouteHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    chat: async () => JSON.stringify({ skillName: "review-code", projectPath: "/dev/acme", confidence: 0.7 }),
    model: "m",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
  });
  const out: RouteSuggestion = await handler({ userText: "go", droppedUrl: "u" });
  expect(out.skillName).toBe("review-code");
  expect(out.projectPath).toBe("/dev/acme");
  expect(out.composedPrompt).toContain("BODY");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app test -- ipc`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `packages/app/src/ipc.ts`**

```ts
import {
  loadSkills, loadProjects, route,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
} from "@bean/core";
import type { RouterDeps } from "@bean/core";

export const IPC = {
  route: "bean:route",
  run: "bean:run",
  runEvent: "bean:run-event",
} as const;

export interface RouteHandlerDeps {
  loadSkills: (dir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  chat: RouterDeps["chat"];
  model: string;
  skillsDir: string;
  projectsFile: string;
}

export function buildRouteHandler(deps: RouteHandlerDeps) {
  return async (input: RouteInput): Promise<RouteSuggestion> => {
    const [skills, projects] = await Promise.all([
      deps.loadSkills(deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
    ]);
    return route(input, skills, projects, { chat: deps.chat, model: deps.model });
  };
}
```

Note: `buildRouteHandler` accepts injected `loadSkills`/`loadProjects` for testability; the real `registerIpc` (Step 5) passes the `@bean/core` implementations.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app test -- ipc`
Expected: PASS.

- [ ] **Step 5: Add `registerIpc` to `packages/app/src/ipc.ts`**

```ts
import type { IpcMain, WebContents } from "electron";
import { runOpencode } from "@bean/core";

export interface RegisterDeps extends RouteHandlerDeps {
  sender: () => WebContents | undefined;
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): void {
  const routeHandler = buildRouteHandler(deps);
  ipcMain.handle(IPC.route, (_e, input: RouteInput) => routeHandler(input));
  ipcMain.handle(IPC.run, async (_e, suggestion: RouteSuggestion) =>
    runOpencode(suggestion, (event) => deps.sender()?.send(IPC.runEvent, event)),
  );
}
```

- [ ] **Step 6: Write `packages/app/src/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./ipc.js";
import type { RouteInput, RouteSuggestion, RunEvent } from "@bean/core";

contextBridge.exposeInMainWorld("bean", {
  route: (input: RouteInput): Promise<RouteSuggestion> => ipcRenderer.invoke(IPC.route, input),
  run: (s: RouteSuggestion): Promise<string> => ipcRenderer.invoke(IPC.run, s),
  onRunEvent: (cb: (e: RunEvent) => void) =>
    ipcRenderer.on(IPC.runEvent, (_e, ev: RunEvent) => cb(ev)),
});
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @bean/app typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(app): IPC route/run handlers and preload bridge"
```

---

## Task 12: Wire main process + Intake + Console + Confirm flow

**Files:**
- Modify: `packages/app/src/main.ts`
- Create: `packages/app/src/renderer/intake.html`, `intake.ts`, `console.html`, `console.ts`
- Modify: `packages/app/src/renderer/avatar.ts` (drop URL + click → open intake)

**Interfaces:**
- Consumes: `registerIpc`, `createAvatarWindow/createIntakeWindow/createConsoleWindow`, config from `@bean/core`.
- Produces: end-to-end flow: avatar → intake → confirm in console → run streaming.

- [ ] **Step 1: Update `packages/app/src/main.ts` to load config and register IPC**

```ts
import { app, ipcMain } from "electron";
import {
  beanDir, configFile, projectsFile, skillsDir,
  loadConfig, loadSkills, loadProjects, makeOpenAIChat,
} from "@bean/core";
import { createAvatarWindow, createConsoleWindow } from "./windows.js";
import { registerIpc } from "./ipc.js";

app.whenReady().then(async () => {
  const dir = beanDir();
  const cfg = await loadConfig(configFile(dir), dir);
  const avatar = createAvatarWindow();
  let consoleWin = createConsoleWindow();

  registerIpc(ipcMain, {
    loadSkills, loadProjects,
    chat: makeOpenAIChat(cfg.openaiApiKey),
    model: cfg.model,
    skillsDir: skillsDir(dir),
    projectsFile: projectsFile(dir),
    sender: () => consoleWin.webContents,
  });

  avatar.on("closed", () => { /* keep app */ });
  consoleWin.on("closed", () => { consoleWin = createConsoleWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

Note: For v1 a single reused Console window is acceptable (one run at a time). <!-- ponytail: per-run windows when concurrency lands -->

- [ ] **Step 2: Create `packages/app/src/renderer/intake.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <textarea id="url" placeholder="Dropped URL"></textarea>
    <textarea id="text" placeholder="What should Bean do?"></textarea>
    <button id="go">Route</button>
    <pre id="out"></pre>
    <script type="module" src="intake.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `packages/app/src/renderer/intake.ts`**

```ts
import type { RouteSuggestion } from "@bean/core";

declare global {
  interface Window {
    bean: {
      route: (i: { userText: string; droppedUrl?: string }) => Promise<RouteSuggestion>;
      run: (s: RouteSuggestion) => Promise<string>;
      onRunEvent: (cb: (e: unknown) => void) => void;
    };
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

$("go").addEventListener("click", async () => {
  const userText = ($("text") as HTMLTextAreaElement).value;
  const droppedUrl = ($("url") as HTMLTextAreaElement).value || undefined;
  const suggestion = await window.bean.route({ userText, droppedUrl });
  // Confirm step: show editable suggestion, then run on confirm.
  const ok = confirm(
    `Run "${suggestion.skillName}" on ${suggestion.projectPath}?\n` +
    `(confidence ${suggestion.confidence})\n\n${suggestion.composedPrompt.slice(0, 400)}…`,
  );
  if (ok) await window.bean.run(suggestion);
});
```

Note: `confirm()` is the v1 confirm gate. <!-- ponytail: rich editable confirm UI later; a native confirm proves the flow now -->

- [ ] **Step 4: Create `packages/app/src/renderer/console.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body><pre id="log"></pre><script type="module" src="console.js"></script></body>
</html>
```

- [ ] **Step 5: Create `packages/app/src/renderer/console.ts`**

```ts
import type { RunEvent } from "@bean/core";

const log = document.getElementById("log") as HTMLPreElement;
window.bean.onRunEvent((e: unknown) => {
  const ev = e as RunEvent;
  if (ev.type === "stdout" || ev.type === "stderr") log.textContent += ev.text;
  else log.textContent += `\n[${ev.status}${ev.exitCode !== undefined ? " " + ev.exitCode : ""}]${ev.message ? " " + ev.message : ""}\n`;
});
```

- [ ] **Step 6: Update `packages/app/src/renderer/avatar.ts` to open intake on click and accept URL drops**

```ts
const el = document.getElementById("bean");
if (el) {
  el.style.fontSize = "72px";
  el.style.cursor = "grab";
  (el.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "drag";

  el.addEventListener("dblclick", () => { window.location.href = "intake.html"; });

  document.body.addEventListener("dragover", (e) => e.preventDefault());
  document.body.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (url) {
      sessionStorage.setItem("droppedUrl", url);
      window.location.href = "intake.html";
    }
  });
}
```

Note: For v1, avatar and intake are the same window navigating between HTML files; `sessionStorage` carries the dropped URL. Intake reads it on load. <!-- ponytail: separate windows + IPC later if needed -->

- [ ] **Step 7: Update `intake.ts` to prefill the dropped URL on load** (add near top, after `$` helper)

```ts
const dropped = sessionStorage.getItem("droppedUrl");
if (dropped) {
  ($("url") as HTMLTextAreaElement).value = dropped;
  sessionStorage.removeItem("droppedUrl");
}
```

- [ ] **Step 8: Typecheck + build**

Run: `pnpm --filter @bean/app typecheck && pnpm --filter @bean/app build`
Expected: PASS, build emits `dist/`.

- [ ] **Step 9: Manual end-to-end smoke (requires `~/.bean/config.json`, one skill, one project)**

Create test fixtures:
```bash
mkdir -p ~/.bean/skills
printf '{"openaiApiKey":"%s","model":"gpt-4o-mini"}' "$OPENAI_API_KEY" > ~/.bean/config.json
printf -- '---\ndescription: Echo task back\n---\n# Echo\nSummarize the task.' > ~/.bean/skills/echo.md
printf '[{"name":"bean","path":"%s"}]' "$PWD" > ~/.bean/projects.json
```
Run: `pnpm --filter @bean/app start`
Expected: avatar appears; double-click opens intake; type "summarize the readme", click Route; a confirm dialog shows skill `echo` + project path; confirming streams opencode output into the console window.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(app): end-to-end avatar->intake->confirm->run flow"
```

---

## Task 13: Root README + run scripts

**Files:**
- Create: `README.md`
- Modify: root `package.json` (add `dev` script)

**Interfaces:**
- Produces: documented setup + `pnpm dev` to build core then start app.

- [ ] **Step 1: Add `dev` script to root `package.json` scripts**

```json
"dev": "turbo run build --filter=@bean/core && pnpm --filter @bean/app build && pnpm --filter @bean/app start"
```

- [ ] **Step 2: Write `README.md`**

```md
# Bean

Desktop pet that routes a loose instruction (+ a dropped URL) to one of your
skills and one of your projects, confirms, then runs `opencode` and streams the output.

## Requirements
- Node 24, pnpm 11
- `opencode` on PATH
- `~/.bean/config.json` → `{ "openaiApiKey": "sk-...", "model": "gpt-4o-mini" }`
- `~/.bean/skills/*.md` → one markdown file per skill (`description:` frontmatter optional)
- `~/.bean/projects.json` → `[{ "name": "...", "path": "/abs/path", "defaultSkill": "..." }]`

## Develop
```bash
pnpm install
pnpm test        # run all unit tests
pnpm dev         # build + launch the app
```

Double-click the avatar (or drop a URL on it) → type an instruction → Route → confirm → watch the run.
```

- [ ] **Step 3: Verify full test + typecheck pass from root**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add README and dev script"
```

---

## Self-Review Notes

- **Spec coverage:** Avatar/Intake/Console windows (T10, T12) ✓; SkillLibrary (T4) ✓; ProjectRegistry (T5) ✓; Router via OpenAI (T7, T8) ✓; inline prompt composition "B" (T3) ✓; confirm-before-run (T12) ✓; runner + streaming + status, correct `opencode run "<prompt>" --dir` invocation (T9) ✓; `~/.bean/` storage (T6) ✓; monorepo/pnpm/turbo/Vitest/`__test__` (T1) ✓; failure handling incl. missing binary (T9) ✓; one-run-at-a-time (T12 note) ✓.
- **Deferred items stay deferred:** pet animation, concurrency, in-app editors, chat persona, file-injection approach — none appear as tasks. ✓
- **Type consistency:** `RouteSuggestion`, `RunEvent`, `RouterDeps.chat`, `SpawnFn`, `buildRouteHandler` signatures are used identically across tasks 7–12. ✓
- **Known v1 simplifications (ponytail-marked):** native `confirm()` as the confirm gate; single reused Console window; avatar/intake as one navigating window with `sessionStorage`. Each has a noted upgrade path.
