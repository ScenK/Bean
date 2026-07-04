# Bean Command Bar + Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's Chat and Command Bar panels a working conversational surface where the OpenAI model replies and can propose an editable route (skill+project) that, on confirm, fires the existing `opencode` runner.

**Architecture:** A new pure, dependency-injected `converse()` in `@bean/core` sends the transcript plus a `propose_run` function-tool to the model and returns `{ reply, proposedRun? }`. Its OpenAI adapter lives only in `openai-chat.ts`. A `bean:chat` IPC handler (mirroring the existing route handler) calls it. The dashboard renderer (Preact) owns an ephemeral transcript, renders bubbles + an editable confirm card + run-status bubbles, and fires the existing `bean:run` on confirm. The command bar is a second input that seeds the same `sendMessage` flow.

**Tech Stack:** TypeScript (strict, ESM, `verbatimModuleSyntax`), Electron, esbuild, Preact, Vitest, OpenAI SDK.

## Global Constraints

- `converse()` and the OpenAI adapter live in `@bean/core`, pure and dependency-injected — no Electron imports. OpenAI SDK usage stays confined to `packages/core/src/openai-chat.ts`.
- `converse()` **never throws** — on any model/parse error it returns `{ reply: <fallback text> }` with no `proposedRun`, matching `route()`'s never-throw contract.
- Do **not** reuse `router.ts`'s `ChatMsg` type (it only allows `"system" | "user"`). Conversation needs a `ConvoMsg` with an `"assistant"` role.
- Chat history is ephemeral — in-memory in the renderer, sent whole each turn. No persistence, no new `~/.bean` files.
- IPC channel names live only in `packages/app/src/channels.ts`, referenced via the `IPC` object — never string-literaled at call sites.
- The Electron preload stays CommonJS (`.cjs`); the esbuild guard against ESM syntax must remain.
- No new test-framework dependency. Renderer UI is verified manually via `pnpm dev`; core/IPC logic is unit-tested with fake clients.
- SP2 ignores `stdout`/`stderr` `RunEvent`s in the chat (only `status` events surface); the raw output stream is SP3's console panel.
- The default system prompt is a placeholder for SP5 (persona) — keep it in one exported constant.
- `pnpm test && pnpm typecheck` (repo root) must both exit 0 before the final task's commit.

---

### Task 1: Core — `converse()` and its types

**Files:**
- Create: `packages/core/src/converse.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: `composePrompt` (`prompt.ts`), `Skill`/`Project`/`RouteSuggestion` (`types.ts`).
- Produces: `ConvoMsg`, `ChatTurn`, `ToolSpec`, `ToolCall`, `ConverseDeps`, `ProposedRun`, `ConverseResult`, `ChatRequest`, `DEFAULT_SYSTEM_PROMPT`, and `converse(history, latestUserText, skills, projects, deps, droppedUrl?): Promise<ConverseResult>`.

- [x] **Step 1: Write the failing test**

```typescript
import { expect, test } from "vitest";
import { converse, type ConverseDeps } from "../src/converse.js";
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
  const res = await converse([], "hi there", skills, projects, depsReturning("Hello!"));
  expect(res.reply).toBe("Hello!");
  expect(res.proposedRun).toBeUndefined();
});

test("valid propose_run tool call composes a run from the local skill body", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "review the 3 PRs" } },
  ]);
  const res = await converse([], "review the PRs in api", skills, projects, deps, "https://linear/BEAN-42");
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
  const res = await converse([], "do a thing", skills, projects, deps);
  expect(res.reply).toBe("Hmm.");
  expect(res.proposedRun).toBeUndefined();
});

test("history turns are accepted and the function never throws on chat failure", async () => {
  const deps: ConverseDeps = { model: "m", chat: async () => { throw new Error("network"); } };
  const res = await converse(
    [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
    "again", skills, projects, deps,
  );
  expect(res.proposedRun).toBeUndefined();
  expect(res.reply.length).toBeGreaterThan(0);
});
```

- [x] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: FAIL — `Cannot find module '../src/converse.js'`

- [x] **Step 3: Implement `converse.ts`**

```typescript
import { composePrompt } from "./prompt.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";

export interface ConvoMsg { role: "system" | "user" | "assistant"; content: string; }
export interface ChatTurn { role: "user" | "assistant"; content: string; }
export interface ToolSpec { name: string; description: string; parameters: object; }
export interface ToolCall { name: string; args: unknown; }
export interface ConverseDeps {
  chat: (a: { model: string; messages: ConvoMsg[]; tools: ToolSpec[] }) => Promise<{
    content: string;
    toolCalls: ToolCall[];
  }>;
  model: string;
}

export type ProposedRun = RouteSuggestion;
export interface ConverseResult { reply: string; proposedRun?: ProposedRun; }
export interface ChatRequest { history: ChatTurn[]; message: string; droppedUrl?: string; }

export const DEFAULT_SYSTEM_PROMPT =
  "You are Bean, a warm, concise desktop coding companion. Reply briefly and directly. " +
  "You cannot do work yourself — a separate `opencode` process does. When the user wants " +
  "a concrete task done in one of their projects, call the propose_run tool with the best " +
  "matching skill name, project path, and a clear instruction; otherwise just reply in text. " +
  "Only propose a run when the user clearly wants work done.";

const PROPOSE_RUN: ToolSpec = {
  name: "propose_run",
  description:
    "Propose running one skill on one project. skill must be one of the listed skill names; " +
    "project must be one of the listed project paths.",
  parameters: {
    type: "object",
    properties: {
      skill: { type: "string", description: "one of the listed skill names" },
      project: { type: "string", description: "one of the listed project paths" },
      instruction: { type: "string", description: "the concrete task instruction" },
    },
    required: ["skill", "project", "instruction"],
  },
};

function catalog(skills: Skill[], projects: Project[]): string {
  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const projectList = projects.map((p) => `- ${p.name} (${p.path})`).join("\n");
  return `Skills:\n${skillList}\n\nProjects:\n${projectList}`;
}

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
    ...history.map((t): ConvoMsg => ({ role: t.role, content: t.content })),
    { role: "user", content: latestUserText },
  ];

  let content = "";
  let toolCalls: ToolCall[] = [];
  try {
    const res = await deps.chat({ model: deps.model, messages, tools: [PROPOSE_RUN] });
    content = res.content;
    toolCalls = res.toolCalls;
  } catch {
    return { reply: "I couldn't reach the model — check your API key in ~/.bean/config.json." };
  }

  const call = toolCalls.find((c) => c.name === "propose_run");
  if (!call) return { reply: content };

  const args = (call.args ?? {}) as { skill?: unknown; project?: unknown; instruction?: unknown };
  const skill = skills.find((s) => s.name === args.skill);
  const project = projects.find((p) => p.path === args.project);
  if (!skill || !project) return { reply: content };

  const instruction = typeof args.instruction === "string" ? args.instruction : latestUserText;
  return {
    reply: content,
    proposedRun: {
      skillName: skill.name,
      projectPath: project.path,
      composedPrompt: composePrompt(skill, instruction, droppedUrl),
      confidence: 1,
    },
  };
}
```

- [x] **Step 4: Add the export to `index.ts`**

Add this line after the existing `export * from "./router.js";`:

```typescript
export * from "./converse.js";
```

- [x] **Step 5: Run the test and verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS (4 tests)

- [x] **Step 6: Commit**

```bash
git add packages/core/src/converse.ts packages/core/src/index.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): add converse() conversational routing path"
```

---

### Task 2: Core — OpenAI converse adapter

**Files:**
- Modify: `packages/core/src/openai-chat.ts`
- Test: `packages/core/__test__/openai-chat.test.ts`

**Interfaces:**
- Consumes: `ConverseDeps`, `ToolCall` (Task 1).
- Produces: `makeOpenAIConverseWithClient(client): ConverseDeps["chat"]`, `makeOpenAIConverse(apiKey): ConverseDeps["chat"]`.

- [x] **Step 1: Append the failing tests to `openai-chat.test.ts`**

```typescript
import { makeOpenAIConverseWithClient } from "../src/openai-chat.js";

test("converse adapter maps content and a tool call", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: "sure",
              tool_calls: [{ function: { name: "propose_run", arguments: '{"skill":"review-code","project":"/work/api","instruction":"go"}' } }],
            },
          }],
        }),
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  const out = await chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  expect(out.content).toBe("sure");
  expect(out.toolCalls).toHaveLength(1);
  expect(out.toolCalls[0]?.name).toBe("propose_run");
  expect((out.toolCalls[0]?.args as { skill?: string }).skill).toBe("review-code");
});

test("converse adapter skips a tool call with malformed arguments", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: { content: "", tool_calls: [{ function: { name: "propose_run", arguments: "{not json" } }] },
          }],
        }),
      },
    },
  };
  const chat = makeOpenAIConverseWithClient(fakeClient as never);
  const out = await chat({ model: "m", messages: [], tools: [] });
  expect(out.content).toBe("");
  expect(out.toolCalls).toHaveLength(0);
});
```

- [x] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/openai-chat.test.ts`
Expected: FAIL — `makeOpenAIConverseWithClient is not exported`

- [x] **Step 3: Implement the adapter in `openai-chat.ts`**

Replace the whole file with:

```typescript
import OpenAI from "openai";
import type { ChatMsg, RouterDeps } from "./router.js";
import type { ConverseDeps, ToolCall } from "./converse.js";

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

interface ToolChatClient {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>;
        tool_choice?: "auto";
      }) => Promise<{
        choices: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> | null;
          };
        }>;
      }>;
    };
  };
}

export function makeOpenAIConverseWithClient(client: ToolChatClient): ConverseDeps["chat"] {
  return async ({ model, messages, tools }) => {
    const res = await client.chat.completions.create({
      model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    });
    const msg = res.choices[0]?.message;
    const content = msg?.content ?? "";
    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      try {
        toolCalls.push({ name, args: JSON.parse(tc.function?.arguments ?? "{}") });
      } catch {
        /* skip malformed tool call */
      }
    }
    return { content, toolCalls };
  };
}

export function makeOpenAIConverse(apiKey: string): ConverseDeps["chat"] {
  const client = new OpenAI({ apiKey }) as unknown as ToolChatClient;
  return makeOpenAIConverseWithClient(client);
}
```

- [x] **Step 4: Run the core gate (tests + typecheck + build)**

Run: `pnpm --filter @bean/core test && pnpm --filter @bean/core exec tsc -p tsconfig.json --noEmit`
Expected: all core tests pass (including the 2 new adapter tests), typecheck exits 0

- [x] **Step 5: Commit**

```bash
git add packages/core/src/openai-chat.ts packages/core/__test__/openai-chat.test.ts
git commit -m "feat(core): add OpenAI converse adapter with tool-call mapping"
```

---

### Task 3: App — chat IPC channel and handler

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `converse`, `ConverseDeps`, `ConverseResult`, `ChatRequest`, `ChatTurn`, `Skill`, `Project` (from `@bean/core`).
- Produces: `IPC.chat`; `ChatHandlerDeps`; `buildChatHandler(deps): (req: ChatRequest) => Promise<ConverseResult>`; `RegisterDeps` extended with `converse: ConverseDeps["chat"]`.

- [x] **Step 1: Add the `chat` channel to `channels.ts`**

Add `chat: "bean:chat",` to the `IPC` object (after `run`):

```typescript
export type Theme = "hearth" | "graphite";

export const IPC = {
  route: "bean:route",
  run: "bean:run",
  chat: "bean:chat",
  runEvent: "bean:run-event",
  getTheme: "bean:get-theme",
  setTheme: "bean:set-theme",
  themeChanged: "bean:theme-changed",
  openDashboard: "bean:open-dashboard",
  dashboardDroppedUrl: "bean:dashboard-dropped-url",
} as const;
```

- [x] **Step 2: Write the failing test (append to `ipc.test.ts`)**

```typescript
import { buildChatHandler } from "../src/ipc.js";

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

- [x] **Step 3: Run the test and verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildChatHandler is not exported`

- [x] **Step 4: Implement in `ipc.ts`**

Update the imports at the top and add the handler + register call. The full file becomes:

```typescript
import {
  route, runOpencode, converse,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest,
} from "@bean/core";
import type { RouterDeps } from "@bean/core";
import type { IpcMain, WebContents } from "electron";
import { IPC, type Theme } from "./channels.js";

export { IPC };

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

export interface ThemeHandlerDeps {
  getCurrentTheme: () => Theme;
  setCurrentTheme: (theme: Theme) => Promise<void>;
}

export function buildThemeHandlers(deps: ThemeHandlerDeps) {
  return {
    get: (): Theme => deps.getCurrentTheme(),
    set: async (theme: Theme): Promise<void> => { await deps.setCurrentTheme(theme); },
  };
}

export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  sender: () => WebContents | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  openDashboard: (droppedUrl?: string) => void;
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): void {
  const routeHandler = buildRouteHandler(deps);
  ipcMain.handle(IPC.route, (_e, input: RouteInput) => routeHandler(input));
  ipcMain.handle(IPC.run, async (_e, suggestion: RouteSuggestion) =>
    runOpencode(suggestion, (event) => deps.sender()?.send(IPC.runEvent, event)),
  );

  const chatHandler = buildChatHandler(deps);
  ipcMain.handle(IPC.chat, (_e, req: ChatRequest) => chatHandler(req));

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.broadcast(IPC.themeChanged, next);
  });

  ipcMain.handle(IPC.openDashboard, (_e, droppedUrl?: string) => deps.openDashboard(droppedUrl));
}
```

- [x] **Step 5: Run the test and verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS (3 tests)

- [x] **Step 6: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): add bean:chat IPC handler"
```

---

### Task 4: App — preload, renderer types, and main wiring

**Files:**
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Modify: `packages/app/src/main.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `ConverseResult`, `ChatTurn` (`@bean/core`); `makeOpenAIConverse` (`@bean/core`); `IPC` (Task 3).
- Produces: `window.bean.chat(req: ChatRequest): Promise<ConverseResult>`.

- [x] **Step 1: Add `chat` to `preload.ts`**

Update imports and add the method:

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Theme } from "./channels.js";
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult } from "@bean/core";

contextBridge.exposeInMainWorld("bean", {
  route: (input: RouteInput): Promise<RouteSuggestion> => ipcRenderer.invoke(IPC.route, input),
  run: (s: RouteSuggestion): Promise<string> => ipcRenderer.invoke(IPC.run, s),
  chat: (req: ChatRequest): Promise<ConverseResult> => ipcRenderer.invoke(IPC.chat, req),
  onRunEvent: (cb: (e: RunEvent) => void) =>
    ipcRenderer.on(IPC.runEvent, (_e, ev: RunEvent) => cb(ev)),
  getTheme: (): Promise<Theme> => ipcRenderer.invoke(IPC.getTheme),
  setTheme: (t: Theme): Promise<void> => ipcRenderer.invoke(IPC.setTheme, t),
  onThemeChanged: (cb: (t: Theme) => void) =>
    ipcRenderer.on(IPC.themeChanged, (_e, t: Theme) => cb(t)),
  openDashboard: (droppedUrl?: string): Promise<void> => ipcRenderer.invoke(IPC.openDashboard, droppedUrl),
  onDashboardDroppedUrl: (cb: (url: string) => void) =>
    ipcRenderer.on(IPC.dashboardDroppedUrl, (_e, url: string) => cb(url)),
});
```

- [x] **Step 2: Add `chat` to `bean.d.ts`**

```typescript
import type { RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult } from "@bean/core";
import type { Theme } from "../channels.js";

declare global {
  interface Window {
    bean: {
      route(input: RouteInput): Promise<RouteSuggestion>;
      run(s: RouteSuggestion): Promise<string>;
      chat(req: ChatRequest): Promise<ConverseResult>;
      onRunEvent(cb: (e: RunEvent) => void): void;
      getTheme(): Promise<Theme>;
      setTheme(t: Theme): Promise<void>;
      onThemeChanged(cb: (t: Theme) => void): void;
      openDashboard(droppedUrl?: string): Promise<void>;
      onDashboardDroppedUrl(cb: (url: string) => void): void;
    };
  }
}

export {};
```

- [x] **Step 3: Wire `converse` into `main.ts`**

Update the core import to add `makeOpenAIConverse`, and add the `converse` dep to the `registerIpc` call. Change the import block:

```typescript
import {
  beanDir, configFile, projectsFile, skillsDir,
  loadConfig, loadSkills, loadProjects, makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
```

and add `converse` to the `registerIpc({...})` object (alongside `chat`):

```typescript
    registerIpc(ipcMain, {
      loadSkills, loadProjects,
      chat: makeOpenAIChat(cfg.openaiApiKey),
      converse: makeOpenAIConverse(cfg.openaiApiKey),
      model: cfg.model,
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      sender: () => dashboardWin?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openDashboard,
    });
```

- [x] **Step 4: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: exits 0

- [x] **Step 5: Commit**

```bash
git add packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/main.ts
git commit -m "feat(app): expose bean.chat and wire converse into main"
```

---

### Task 5: Renderer — chat and command-bar CSS

**Files:**
- Modify: `packages/app/src/renderer/dashboard.css`

**Interfaces:**
- Produces: classes `.bean-chat`, `.bean-chat-scroll`, `.bean-bubble`, `.bean-bubble--user`, `.bean-bubble--bean`, `.bean-status`, `.bean-status--info`, `.bean-status--done`, `.bean-status--error`, `.bean-card`, `.bean-card-chips`, `.bean-chip`, `.bean-card-prompt`, `.bean-card-actions`, `.bean-btn`, `.bean-btn--ghost`, `.bean-chat-input`, `.bean-input`, `.bean-send`, `.bean-cmd`, `.bean-cmd-chip`.

- [x] **Step 1: Append to `dashboard.css`**

```css
/* --- chat + command bar (SP2) --- */
.bean-chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.bean-chat-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bean-bubble {
  max-width: 82%;
  padding: 10px 13px;
  font-size: 13.5px;
  line-height: 1.5;
}
.bean-bubble--bean {
  align-self: flex-start;
  background: var(--bean-surface-2);
  border: 1px solid var(--bean-border);
  border-radius: 4px 14px 14px 14px;
  color: var(--bean-text);
}
.bean-bubble--user {
  align-self: flex-end;
  background: var(--bean-accent);
  color: var(--bean-accent-ink);
  border-radius: 14px 4px 14px 14px;
}
.bean-status {
  align-self: center;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--bean-border);
  color: var(--bean-text-dim);
}
.bean-status--info { color: var(--bean-text-dim); }
.bean-status--done { color: var(--bean-orb-check-ink); border-color: var(--bean-orb-check-ink); }
.bean-status--error { color: #e5484d; border-color: #e5484d; }

.bean-card {
  align-self: stretch;
  background: var(--bean-surface-2);
  border: 1px solid var(--bean-accent);
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bean-card-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.bean-chip {
  font: 600 12px ui-monospace, monospace;
  color: var(--bean-accent-ink);
  background: var(--bean-accent);
  border-radius: 999px;
  padding: 4px 10px;
}
.bean-card-prompt {
  width: 100%;
  min-height: 84px;
  resize: vertical;
  font: 12px/1.5 ui-monospace, monospace;
  color: var(--bean-text);
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 8px;
  padding: 9px 11px;
  box-sizing: border-box;
}
.bean-card-actions { display: flex; gap: 8px; }
.bean-btn {
  font: 600 12px sans-serif;
  color: var(--bean-accent-ink);
  background: var(--bean-accent);
  border: none;
  border-radius: 9px;
  padding: 7px 14px;
  cursor: pointer;
}
.bean-btn--ghost {
  color: var(--bean-text);
  background: transparent;
  border: 1px solid var(--bean-border);
}
.bean-btn:disabled { opacity: 0.5; cursor: default; }

.bean-chat-input {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-top: 1px solid var(--bean-border);
}
.bean-input {
  flex: 1;
  font-size: 13.5px;
  color: var(--bean-text);
  background: var(--bean-surface-2);
  border: 1px solid var(--bean-border);
  border-radius: 12px;
  padding: 9px 13px;
  outline: none;
}
.bean-send {
  width: 30px;
  height: 30px;
  flex: none;
  border: none;
  border-radius: 50%;
  background: var(--bean-accent);
  color: var(--bean-accent-ink);
  font-size: 14px;
  cursor: pointer;
}
.bean-send:disabled { opacity: 0.5; cursor: default; }

.bean-cmd {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 15px 17px;
}
.bean-cmd-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 12px ui-monospace, monospace;
  color: var(--bean-text-dim);
  background: var(--bean-surface-2);
  border: 1px solid var(--bean-border);
  border-radius: 999px;
  padding: 5px 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [x] **Step 2: Build**

Run: `pnpm --filter @bean/app build`
Expected: exits 0; `dist/renderer/dashboard.css` updated

- [x] **Step 3: Commit**

```bash
git add packages/app/src/renderer/dashboard.css
git commit -m "feat(app): add chat and command-bar CSS"
```

---

### Task 6: Renderer — chat item model and proposal card component

**Files:**
- Create: `packages/app/src/renderer/dashboard/chat-types.ts`
- Create: `packages/app/src/renderer/dashboard/ProposalCard.tsx`

**Interfaces:**
- Consumes: `ProposedRun` (`@bean/core`).
- Produces: `ChatItem` union + `newId()`; `ProposalCard({ run, state, onConfirm, onCancel })`.

- [x] **Step 1: Create `chat-types.ts`**

```typescript
import type { ProposedRun } from "@bean/core";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "reply"; id: string; text: string }
  | { kind: "proposal"; id: string; run: ProposedRun; state: "pending" | "confirmed" | "cancelled" }
  | { kind: "status"; id: string; text: string; tone: "info" | "done" | "error" };

let counter = 0;
export function newId(): string {
  counter += 1;
  return `item-${counter}`;
}
```

- [x] **Step 2: Create `ProposalCard.tsx`**

```tsx
import { useState } from "preact/hooks";
import type { ProposedRun } from "@bean/core";

export function ProposalCard({
  run,
  state,
  onConfirm,
  onCancel,
}: {
  run: ProposedRun;
  state: "pending" | "confirmed" | "cancelled";
  onConfirm: (editedPrompt: string) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(run.composedPrompt);
  const done = state !== "pending";

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">skill · {run.skillName}</span>
        <span class="bean-chip">project · {run.projectPath}</span>
      </div>
      <textarea
        class="bean-card-prompt"
        value={prompt}
        disabled={done}
        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
      />
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done} onClick={() => onConfirm(prompt)}>
          {state === "confirmed" ? "Running…" : "Confirm & run"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onCancel}>
          {state === "cancelled" ? "Cancelled" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
```

- [x] **Step 3: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: exits 0

- [x] **Step 4: Commit**

```bash
git add packages/app/src/renderer/dashboard/chat-types.ts packages/app/src/renderer/dashboard/ProposalCard.tsx
git commit -m "feat(app): add chat item model and proposal card"
```

---

### Task 7: Renderer — App state, sendMessage, run events, orb activity

**Files:**
- Modify: `packages/app/src/renderer/dashboard/App.tsx`
- Modify: `packages/app/src/renderer/dashboard/TitleBar.tsx`

**Interfaces:**
- Consumes: `ChatItem`, `newId` (Task 6); `ChatTurn`, `RouteSuggestion`, `RunEvent` (`@bean/core`); `OrbState` (`orb.ts`).
- Produces: `App` passing `items`, `busy`, `onSend`, `onConfirm`, `onCancel` to `ChatPanel`, and `droppedUrl`, `onSend`, `busy` to `CommandBarPanel`; `TitleBar` accepts an `activity: OrbState` prop and drives the orb.

- [x] **Step 1: Rewrite `App.tsx`**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { TitleBar } from "./TitleBar.js";
import { CommandBarPanel } from "./panels/CommandBarPanel.js";
import { ChatPanel } from "./panels/ChatPanel.js";
import { ConsolePanel } from "./panels/ConsolePanel.js";
import { SkillsPanel } from "./panels/SkillsPanel.js";
import { PersonaPanel } from "./panels/PersonaPanel.js";
import { ProjectsPanel } from "./panels/ProjectsPanel.js";
import { newId, type ChatItem } from "./chat-types.js";
import type { Theme } from "../../channels.js";
import type { ChatTurn, RouteSuggestion, RunEvent } from "@bean/core";
import type { OrbState } from "../orb.js";

export function App() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [droppedUrl, setDroppedUrl] = useState<string | undefined>(
    new URLSearchParams(window.location.search).get("droppedUrl") ?? undefined,
  );
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<OrbState>("idle");
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.onDashboardDroppedUrl(setDroppedUrl);
    window.bean.onRunEvent((ev: RunEvent) => {
      if (ev.type !== "status") return; // stdout/stderr belong to SP3's console
      if (ev.status === "running") {
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: "Spinning up…", tone: "info" }]);
        setActivity("working");
      } else if (ev.status === "done") {
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: "Done.", tone: "done" }]);
        setActivity("done");
        setTimeout(() => setActivity("idle"), 1500);
      } else {
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Failed${ev.message ? ": " + ev.message : ""}`, tone: "error" }]);
        setActivity("idle");
      }
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = (): void => {
    void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth");
  };

  const sendMessage = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || busy) return;
    const url = droppedUrl;
    setDroppedUrl(undefined);
    setBusy(true);
    setActivity("working");
    setItems((prev) => [...prev, { kind: "user", id: newId(), text: message }]);

    const history: ChatTurn[] = itemsRef.current
      .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
      .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));

    const res = await window.bean.chat({ history, message, droppedUrl: url });

    setItems((prev) => {
      const next = [...prev];
      if (res.reply.trim()) next.push({ kind: "reply", id: newId(), text: res.reply });
      if (res.proposedRun) next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
      return next;
    });
    setBusy(false);
    setActivity("idle");
  };

  const confirmProposal = (id: string, editedPrompt: string, run: RouteSuggestion): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "confirmed" } : it)));
    void window.bean.run({ ...run, composedPrompt: editedPrompt });
  };

  const cancelProposal = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "cancelled" } : it)));
  };

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={toggleTheme} activity={activity} />
      <div class="bean-dashboard-grid">
        <CommandBarPanel droppedUrl={droppedUrl} busy={busy} onSend={sendMessage} />
        <ChatPanel items={items} busy={busy} onSend={sendMessage} onConfirm={confirmProposal} onCancel={cancelProposal} />
        <ConsolePanel />
        <SkillsPanel />
        <PersonaPanel />
        <ProjectsPanel />
      </div>
    </div>
  );
}
```

- [x] **Step 2: Update `TitleBar.tsx` to accept and apply `activity`**

```tsx
import { useEffect, useRef } from "preact/hooks";
import { createOrb, type OrbHandle, type OrbState } from "../orb.js";
import type { Theme } from "../../channels.js";

export function TitleBar({
  theme,
  onToggleTheme,
  activity,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  activity: OrbState;
}) {
  const orbRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OrbHandle | null>(null);

  useEffect(() => {
    if (orbRef.current && !handleRef.current) {
      handleRef.current = createOrb(orbRef.current, { size: 22 });
    }
  }, []);

  useEffect(() => {
    handleRef.current?.setState(activity);
  }, [activity]);

  return (
    <div class="bean-titlebar">
      <span class="bean-titlebar-dot" />
      <span class="bean-titlebar-name">Bean</span>
      <span class="bean-titlebar-menu">File</span>
      <span class="bean-titlebar-menu">View</span>
      <span class="bean-titlebar-spacer" />
      <div class="bean-titlebar-orb" ref={orbRef} />
      <span class="bean-titlebar-status">{activity === "working" ? "working" : "waiting"}</span>
      <button type="button" class="bean-theme-toggle" onClick={onToggleTheme}>
        {theme === "hearth" ? "Graphite" : "Hearth"}
      </button>
    </div>
  );
}
```

Note: build/typecheck of `App.tsx` is deferred to Task 9 — it imports the not-yet-updated `ChatPanel`/`CommandBarPanel` prop shapes. Commit this task's files now; Task 9 runs the gate.

- [x] **Step 3: Commit**

```bash
git add packages/app/src/renderer/dashboard/App.tsx packages/app/src/renderer/dashboard/TitleBar.tsx
git commit -m "feat(app): wire chat state, run events, and orb activity in App"
```

---

### Task 8: Renderer — ChatPanel

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/ChatPanel.tsx`

**Interfaces:**
- Consumes: `ChatItem` (Task 6); `ProposalCard` (Task 6); `RouteSuggestion` (`@bean/core`); `PanelHeader` (`../Panel.js`).
- Produces: `ChatPanel({ items, busy, onSend, onConfirm, onCancel })`.

- [x] **Step 1: Rewrite `ChatPanel.tsx`**

```tsx
import { useRef } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import { ProposalCard } from "../ProposalCard.js";
import type { ChatItem } from "../chat-types.js";
import type { RouteSuggestion } from "@bean/core";

export function ChatPanel({
  items,
  busy,
  onSend,
  onConfirm,
  onCancel,
}: {
  items: ChatItem[];
  busy: boolean;
  onSend: (text: string) => void;
  onConfirm: (id: string, editedPrompt: string, run: RouteSuggestion) => void;
  onCancel: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (): void => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value;
    el.value = "";
    onSend(text);
  };

  return (
    <div class="bean-panel">
      <PanelHeader title="Chat" />
      <div class="bean-chat">
        <div class="bean-chat-scroll">
          {items.length === 0 ? (
            <div class="bean-panel-empty">Ask Bean to do something, or just say hi.</div>
          ) : null}
          {items.map((it) => {
            if (it.kind === "user") return <div key={it.id} class="bean-bubble bean-bubble--user">{it.text}</div>;
            if (it.kind === "reply") return <div key={it.id} class="bean-bubble bean-bubble--bean">{it.text}</div>;
            if (it.kind === "status") return <div key={it.id} class={`bean-status bean-status--${it.tone}`}>{it.text}</div>;
            return (
              <ProposalCard
                key={it.id}
                run={it.run}
                state={it.state}
                onConfirm={(edited) => onConfirm(it.id, edited, it.run)}
                onCancel={() => onCancel(it.id)}
              />
            );
          })}
        </div>
        <div class="bean-chat-input">
          <input
            ref={inputRef}
            class="bean-input"
            type="text"
            placeholder="Message Bean…"
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <button type="button" class="bean-send" disabled={busy} onClick={submit}>↑</button>
        </div>
      </div>
    </div>
  );
}
```

Note: build/typecheck still deferred to Task 9 (CommandBarPanel's props aren't updated yet).

- [x] **Step 2: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/ChatPanel.tsx
git commit -m "feat(app): build out ChatPanel (bubbles, cards, input)"
```

---

### Task 9: Renderer — CommandBarPanel and the build gate

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/CommandBarPanel.tsx`

**Interfaces:**
- Consumes: `PanelHeader` (`../Panel.js`).
- Produces: `CommandBarPanel({ droppedUrl, busy, onSend })`.

- [x] **Step 1: Rewrite `CommandBarPanel.tsx`**

```tsx
import { useRef } from "preact/hooks";
import { PanelHeader } from "../Panel.js";

export function CommandBarPanel({
  droppedUrl,
  busy,
  onSend,
}: {
  droppedUrl?: string;
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (): void => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value;
    el.value = "";
    onSend(text);
  };

  return (
    <div class="bean-panel bean-panel--wide">
      <PanelHeader title="Command Bar" />
      <div class="bean-cmd">
        {droppedUrl ? <span class="bean-cmd-chip">🔗 {droppedUrl}</span> : null}
        <div class="bean-chat-input" style="border-top:none;padding:0">
          <input
            ref={inputRef}
            class="bean-input"
            type="text"
            placeholder="Tell Bean what to do…"
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <button type="button" class="bean-send" disabled={busy} onClick={submit}>⏎</button>
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 2: Build and typecheck (covers Tasks 7, 8, 9)**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: both exit 0; `dist/renderer/dashboard.js` rebuilt

- [x] **Step 3: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/CommandBarPanel.tsx
git commit -m "feat(app): build out CommandBarPanel with dropped-URL chip"
```

---

### Task 10: Full gate and manual verification

**Files:** none (verification only)

- [x] **Step 1: Run the full validation gate**

Run: `pnpm test && pnpm typecheck` (repo root)
Expected: both exit 0 across all packages (core: converse + adapter tests added; app: chat IPC test added)

- [x] **Step 2: Manually verify in the running app**

Run: `pnpm dev`

You need a valid `~/.bean/config.json` (OpenAI key + model), at least one skill in `~/.bean/skills/*.md`, and at least one project in `~/.bean/projects.json` for the full flow. Check and note what you observe:
- Open the dashboard (double-click avatar). Type a chit-chat message ("hi") in the Chat input → Bean replies in a bubble; no card.
- Type a work request ("review the PRs in the api project") → Bean replies and a confirm card appears showing a `skill · …` chip, a `project · …` chip, and an editable prompt textarea.
- Edit the prompt text, click **Confirm & run** → a "Spinning up…" status bubble appears; the title-bar orb switches to its working animation; on completion a "Done." (or failure) status bubble appears and the orb settles to idle.
- Send another work request and click **Cancel** → no run fires; the card shows "Cancelled".
- Type in the **Command Bar** input (top) instead → the message appears as a user bubble in the Chat panel and flows identically.
- Drag a URL onto the avatar → dashboard opens, the Command Bar shows a URL chip; send a message → the chip clears and (for a proposed run) the composed prompt includes the URL as context.
- Temporarily rename `~/.bean/config.json`'s key to empty (or point to a bad key) and send a message → you get the graceful fallback reply ("I couldn't reach the model…"), not a hang or crash. Restore the config afterward.

- [x] **Step 3: Fix anything that doesn't match, then re-run Steps 1–2**

- [ ] **Step 4: Final commit (only if Step 3 required fixes not yet committed)**

```bash
git add -A
git commit -m "fix(app): address manual verification findings for command bar + chat"
```
