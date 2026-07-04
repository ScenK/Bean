# SP7: Multi-launcher + Task Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select a project in the Projects panel, launch it via `opencode run` /
`claude -p` / `open` (Zed), and watch/cancel each launch as a summary card in a capped,
session-only task-monitor list — independent of the existing chat-driven single-run flow.

**Architecture:** A new Node-only `packages/core/src/launcher.ts` maps a `LaunchMode` to a
command/args pair and spawns+tracks it, emitting status-only `TaskEvent`s (no stdout/stderr
streaming — summary cards only). Two new IPC channels (`bean:launch-task` invoke,
`bean:cancel-task` invoke) plus one push channel (`bean:task-event`) carry these events to the
renderer, where `App.tsx` lifts a capped `tasks` list and passes it + launch/cancel callbacks
into an extended `ProjectsPanel` (row selection + launch chips + inline prompt form) and a new
`TaskMonitor` card list. The existing `runner.ts`/`RunEvent`/`ConsolePanel`/chat flow is
untouched.

**Tech Stack:** TypeScript, Node `child_process`, Electron IPC (`ipcMain.handle`/
`ipcRenderer.invoke`/`.on`), Preact (renderer), Vitest.

## Global Constraints

- `@bean/core` stays pure and Electron-free, dependency-injected — `launcher.ts` takes an
  injectable `spawnFn`, exactly like `runner.ts`'s `SpawnFn` pattern.
- IPC channel names live only in `packages/app/src/channels.ts`'s `IPC` constant — never
  string-literal a `"bean:..."` channel name elsewhere.
- No new test-framework dependency; renderer UI is verified manually via `pnpm dev`, core/IPC
  logic is unit-tested with injected fakes (Vitest, matching `runner.test.ts`/`ipc.test.ts`).
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0.
- Do not modify `runner.ts`, `RunEvent`, `ConsolePanel.tsx`, or the chat/`ProposalCard` flow —
  this SP is fully additive and parallel to them.
- `open` mode is hardcoded to the `zed` CLI (no config surface). `shell` mode is out of scope
  entirely (future SP). No stdout/stderr log view for tasks — summary cards only (status, pid,
  elapsed, exit code, a one-line failure message).
- Task history is in-memory, session-only (renderer state, cleared on dashboard window
  close/reopen), capped at 20 entries — never evicting a currently-`running` task to make
  room.

---

### Task 1: `packages/core/src/launcher.ts` — types + `launchCommand`

**Files:**
- Create: `packages/core/src/launcher.ts`
- Test: `packages/core/__test__/launcher.test.ts`

**Interfaces:**
- Consumes: nothing (new pure module).
- Produces: `LaunchMode`, `TaskStatus`, `LaunchRequest`, `TaskEvent`, `launchCommand(req:
  LaunchRequest): { command: string; args: string[] }` — consumed by Task 2 (`launchTask`) and
  Task 4 (`ipc.ts`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/launcher.test.ts`:

```typescript
import { expect, test } from "vitest";
import { launchCommand } from "../src/launcher.js";
import type { LaunchRequest } from "../src/launcher.js";

test("launchCommand builds the opencode run command", () => {
  const req: LaunchRequest = {
    mode: "opencode", projectPath: "/dev/acme", projectName: "acme", prompt: "do it",
  };
  expect(launchCommand(req)).toEqual({ command: "opencode", args: ["run", "do it", "--dir", "/dev/acme"] });
});

test("launchCommand builds the claude -p command", () => {
  const req: LaunchRequest = {
    mode: "claude", projectPath: "/dev/acme", projectName: "acme", prompt: "do it",
  };
  expect(launchCommand(req)).toEqual({ command: "claude", args: ["-p", "do it"] });
});

test("launchCommand builds the open (zed) command with no prompt needed", () => {
  const req: LaunchRequest = {
    mode: "open", projectPath: "/dev/acme", projectName: "acme",
  };
  expect(launchCommand(req)).toEqual({ command: "zed", args: ["/dev/acme"] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run launcher.test.ts`
Expected: FAIL — `Cannot find module '../src/launcher.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/launcher.ts`:

```typescript
export type LaunchMode = "opencode" | "claude" | "open";
export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export interface LaunchRequest {
  mode: LaunchMode;
  projectPath: string;
  projectName: string;
  prompt?: string; // required for "opencode"/"claude", ignored for "open"
}

export interface TaskEvent {
  taskId: string;
  status: TaskStatus;
  pid?: number;
  exitCode?: number;
  message?: string;
}

export function launchCommand(req: LaunchRequest): { command: string; args: string[] } {
  switch (req.mode) {
    case "opencode":
      return { command: "opencode", args: ["run", req.prompt ?? "", "--dir", req.projectPath] };
    case "claude":
      return { command: "claude", args: ["-p", req.prompt ?? ""] };
    case "open":
      return { command: "zed", args: [req.projectPath] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run launcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/launcher.ts packages/core/__test__/launcher.test.ts
git commit -m "feat(core): add launchCommand for opencode/claude/open launch modes"
```

---

### Task 2: `launchTask` — spawn, track, emit status events

**Files:**
- Modify: `packages/core/src/launcher.ts`
- Test: `packages/core/__test__/launcher.test.ts`

**Interfaces:**
- Consumes: `LaunchRequest`, `TaskEvent`, `launchCommand` from Task 1.
- Produces: `LaunchSpawnFn` (type), `LaunchHandle` (interface: `{ child: ChildProcess; cancel:
  () => void }`), `launchTask(taskId: string, req: LaunchRequest, onEvent: (event: TaskEvent)
  => void, spawnFn?: LaunchSpawnFn): LaunchHandle` — consumed by Task 4 (`ipc.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__test__/launcher.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { launchTask, type LaunchSpawnFn, type TaskEvent } from "../src/launcher.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: { end: () => void };
    stderr: EventEmitter;
    kill: () => void;
  };
  child.pid = 4242;
  child.stdin = { end: () => {} };
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("close", null);
  return child;
}

const req = { mode: "opencode" as const, projectPath: "/dev/acme", projectName: "acme", prompt: "go" };

test("launchTask emits running then done on exit 0", () => {
  const child = fakeChild();
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  launchTask("t1", req, (e) => events.push(e), spawnFn);
  child.emit("close", 0);
  expect(events[0]).toEqual({ taskId: "t1", status: "running", pid: 4242 });
  expect(events[1]).toEqual({ taskId: "t1", status: "done", exitCode: 0 });
});

test("launchTask emits failed with a truncated stderr tail on non-zero exit", () => {
  const child = fakeChild();
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  launchTask("t2", req, (e) => events.push(e), spawnFn);
  const longTail = "e".repeat(600);
  child.stderr.emit("data", Buffer.from(longTail));
  child.emit("close", 1);
  const last = events.at(-1)!;
  expect(last.status).toBe("failed");
  expect(last.exitCode).toBe(1);
  expect(last.message).toHaveLength(500);
  expect(last.message).toBe(longTail.slice(-500));
});

test("launchTask reports cancelled (not failed) when cancel() is called before close", () => {
  const child = fakeChild();
  child.kill = () => { /* real kill wouldn't emit synchronously; simulate async close */ };
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  const handle = launchTask("t3", req, (e) => events.push(e), spawnFn);
  handle.cancel();
  child.emit("close", 143);
  const last = events.at(-1)!;
  expect(last.status).toBe("cancelled");
  expect(last.exitCode).toBe(143);
  expect(last.message).toBeUndefined();
});

test("launchTask reports cancelled (not failed) if kill surfaces as an error event", () => {
  const child = fakeChild();
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  const handle = launchTask("t4", req, (e) => events.push(e), spawnFn);
  handle.cancel();
  child.emit("error", new Error("kill ESRCH"));
  const last = events.at(-1)!;
  expect(last.status).toBe("cancelled");
  expect(last.message).toBeUndefined();
});

test("launchTask emits failed with the spawn error message on a genuine spawn error", () => {
  const child = fakeChild();
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  launchTask("t5", req, (e) => events.push(e), spawnFn);
  child.emit("error", new Error("spawn opencode ENOENT"));
  const last = events.at(-1)!;
  expect(last.status).toBe("failed");
  expect(last.message).toBe("spawn opencode ENOENT");
});

test("launchTask settled guard: close after error does not emit a second terminal event", () => {
  const child = fakeChild();
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  launchTask("t6", req, (e) => events.push(e), spawnFn);
  child.emit("error", new Error("x"));
  child.emit("close", 1);
  const terminal = events.filter((e) => e.status !== "running");
  expect(terminal).toHaveLength(1);
});

test("launchTask does not throw when the spawned child has no stdin or stderr", () => {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void };
  child.pid = 1;
  child.kill = () => {};
  const spawnFn: LaunchSpawnFn = () => child as never;
  const events: TaskEvent[] = [];
  expect(() => launchTask("t7", req, (e) => events.push(e), spawnFn)).not.toThrow();
  child.emit("close", 0);
  expect(events.at(-1)?.status).toBe("done");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run launcher.test.ts`
Expected: FAIL — `launchTask`/`LaunchSpawnFn`/`TaskEvent` are not exported from
`../src/launcher.js` yet.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/launcher.ts`:

```typescript
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export type LaunchSpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string },
) => ChildProcess;

const defaultLaunchSpawn: LaunchSpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });

export interface LaunchHandle {
  child: ChildProcess;
  cancel: () => void;
}

const STDERR_TAIL_MAX = 500;

export function launchTask(
  taskId: string,
  req: LaunchRequest,
  onEvent: (event: TaskEvent) => void,
  spawnFn: LaunchSpawnFn = defaultLaunchSpawn,
): LaunchHandle {
  const { command, args } = launchCommand(req);
  const child = spawnFn(command, args, { cwd: req.projectPath });
  onEvent({ taskId, status: "running", pid: child.pid });

  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_MAX);
  });

  let settled = false;
  let cancelled = false;

  child.on("error", (err: Error) => {
    if (settled) return;
    settled = true;
    onEvent({
      taskId,
      status: cancelled ? "cancelled" : "failed",
      message: cancelled ? undefined : err.message,
    });
  });

  child.on("close", (code: number | null) => {
    if (settled) return;
    settled = true;
    const status: TaskStatus = cancelled ? "cancelled" : code === 0 ? "done" : "failed";
    onEvent({
      taskId,
      status,
      exitCode: code ?? undefined,
      message: status === "failed" ? (stderrTail || undefined) : undefined,
    });
  });

  return {
    child,
    cancel: () => {
      cancelled = true;
      child.kill();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run launcher.test.ts`
Expected: PASS (10 tests total: 3 from Task 1 + 7 from this task).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/launcher.ts packages/core/__test__/launcher.test.ts
git commit -m "feat(core): add launchTask to spawn/track/cancel launcher subprocesses"
```

---

### Task 3: Export `launcher.ts` from the `@bean/core` barrel

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `launcher.ts`'s exports from Tasks 1–2.
- Produces: `LaunchMode`, `TaskStatus`, `LaunchRequest`, `TaskEvent`, `LaunchHandle`,
  `LaunchSpawnFn`, `launchCommand`, `launchTask` all importable from `@bean/core` — consumed
  by Task 4 (`ipc.ts`, real value import) and Task 7 (`App.tsx`/`ProjectsPanel.tsx`, type-only
  import — no new Node-free subpath needed since the renderer only ever imports *types* from
  this module, exactly like it already does for `RunEvent`/`RouteSuggestion`).

- [ ] **Step 1: Add the export**

Edit `packages/core/src/index.ts`, add this line after `export * from "./terminal.js";`:

```typescript
export * from "./launcher.js";
```

- [ ] **Step 2: Verify the whole core package still builds and tests pass**

Run: `pnpm --filter @bean/core exec vitest run`
Expected: PASS (all existing + new launcher tests).

Run: `pnpm --filter @bean/core exec tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export launcher.ts from the @bean/core barrel"
```

---

### Task 4: IPC — channels, `buildLaunchHandlers`, `registerIpc` wiring

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `launchTask`, `LaunchHandle`, `LaunchSpawnFn`, `LaunchRequest`, `TaskEvent` from
  `@bean/core` (Task 3).
- Produces: `IPC.launchTask`, `IPC.cancelTask`, `IPC.taskEvent` channel name constants;
  `LaunchHandlerDeps` (interface), `buildLaunchHandlers(deps): { launch: (taskId: string, req:
  LaunchRequest) => void; cancel: (taskId: string) => void }` — following the exact same
  `buildXHandler(s)`-returns-a-plain-object pattern as the existing `buildThemeHandlers`/
  `buildPersonaHandlers` (a shared `Map` closure over the running tasks, same reason
  `buildPersonaHandlers` shares `deps` between its `get`/`save` methods) — consumed by
  `registerIpc` in this task and directly unit-tested with no fake `ipcMain` needed, matching
  how every other handler in this file is tested.

- [ ] **Step 1: Write the failing tests**

Append to `packages/app/__test__/ipc.test.ts`:

```typescript
import { buildLaunchHandlers } from "../src/ipc.js";
import { IPC } from "../src/channels.js";
import type { LaunchSpawnFn, TaskEvent } from "@bean/core";
import { EventEmitter } from "node:events";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void };
  child.pid = 99;
  child.kill = () => child.emit("close", null);
  return child;
}

test("launch handler spawns via injected spawnLaunch and forwards events to the sender", () => {
  const child = fakeChild();
  const spawnLaunch: LaunchSpawnFn = () => child as never;
  const sent: [string, TaskEvent][] = [];
  const handlers = buildLaunchHandlers({
    spawnLaunch,
    sender: () => ({ send: (ch: string, payload: unknown) => sent.push([ch, payload as TaskEvent]) }) as never,
  });

  handlers.launch("t1", { mode: "open", projectPath: "/p", projectName: "p" });
  child.emit("close", 0);

  expect(sent[0]).toEqual([IPC.taskEvent, { taskId: "t1", status: "running", pid: 99 }]);
  expect(sent[1]![1]).toMatchObject({ taskId: "t1", status: "done" });
});

test("cancel handler cancels a known running task and no-ops for an unknown id", () => {
  const child = fakeChild();
  const spawnLaunch: LaunchSpawnFn = () => child as never;
  const sent: [string, TaskEvent][] = [];
  const handlers = buildLaunchHandlers({
    spawnLaunch,
    sender: () => ({ send: (ch: string, payload: unknown) => sent.push([ch, payload as TaskEvent]) }) as never,
  });

  handlers.launch("t2", { mode: "open", projectPath: "/p", projectName: "p" });
  expect(() => handlers.cancel("no-such-id")).not.toThrow();
  handlers.cancel("t2");
  expect(sent.at(-1)![1].status).toBe("cancelled");
});

test("task map entry is removed after a terminal event (no leak across repeated launches)", () => {
  const child = fakeChild();
  const spawnLaunch: LaunchSpawnFn = () => child as never;
  const handlers = buildLaunchHandlers({ spawnLaunch, sender: () => undefined });

  handlers.launch("t3", { mode: "open", projectPath: "/p", projectName: "p" });
  child.emit("close", 0);
  // Cancelling after completion must not throw (map entry already cleared).
  expect(() => handlers.cancel("t3")).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run ipc.test.ts`
Expected: FAIL — `buildLaunchHandlers` is not exported from `../src/ipc.js` (doesn't exist
yet), and `IPC.taskEvent` is `undefined` (channel not added yet).

- [ ] **Step 3: Write minimal implementation**

Edit `packages/app/src/channels.ts` — add three entries to the `IPC` object (after
`saveSkill: "bean:save-skill",`):

```typescript
  launchTask: "bean:launch-task",
  cancelTask: "bean:cancel-task",
  taskEvent: "bean:task-event",
```

Edit `packages/app/src/ipc.ts`:

1. Add to the imports from `@bean/core`:

```typescript
import {
  route, runOpencode, converse, launchTask,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type LaunchRequest, type LaunchHandle, type LaunchSpawnFn,
} from "@bean/core";
```

2. Add a new interface + builder function (after `buildSaveSkillHandler` and its
   `SaveSkillHandlerDeps`, before the `PersonaHandlerDeps`/`buildPersonaHandlers` block):

```typescript
export interface LaunchHandlerDeps {
  sender: () => WebContents | undefined;
  spawnLaunch?: LaunchSpawnFn;
}

export function buildLaunchHandlers(deps: LaunchHandlerDeps) {
  const tasks = new Map<string, LaunchHandle>();
  return {
    launch: (taskId: string, req: LaunchRequest): void => {
      const handle = launchTask(
        taskId,
        req,
        (ev) => {
          deps.sender()?.send(IPC.taskEvent, ev);
          if (ev.status !== "running") tasks.delete(taskId);
        },
        deps.spawnLaunch,
      );
      tasks.set(taskId, handle);
    },
    cancel: (taskId: string): void => { tasks.get(taskId)?.cancel(); },
  };
}
```

3. Extend `RegisterDeps` (add after `openDashboard: (droppedUrl?: string) => void;`):

```typescript
  spawnLaunch?: LaunchSpawnFn;
```

4. Inside `registerIpc`, add (after the existing `saveSkillHandler` registration, before the
   `personaHandlers` block):

```typescript
  const launchHandlers = buildLaunchHandlers(deps);
  ipcMain.handle(IPC.launchTask, (_e, taskId: string, req: LaunchRequest) => launchHandlers.launch(taskId, req));
  ipcMain.handle(IPC.cancelTask, (_e, taskId: string) => launchHandlers.cancel(taskId));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run ipc.test.ts`
Expected: PASS (all existing ipc tests + 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): add buildLaunchHandlers and wire launchTask/cancelTask IPC"
```

---

### Task 5: Preload bridge + renderer types

**Files:**
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`

**Interfaces:**
- Consumes: `IPC.launchTask`/`IPC.cancelTask`/`IPC.taskEvent` (Task 4), `LaunchRequest`,
  `TaskEvent` types from `@bean/core` (Task 3).
- Produces: `window.bean.launchTask(taskId, req)`, `window.bean.cancelTask(taskId)`,
  `window.bean.onTaskEvent(cb)` — consumed by Task 7 (`App.tsx`).

- [ ] **Step 1: Update preload**

Edit `packages/app/src/preload.ts`:

1. Extend the type import:

```typescript
import type {
  RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project, Persona,
  LaunchRequest, TaskEvent,
} from "@bean/core";
```

2. Add to the `contextBridge.exposeInMainWorld("bean", { ... })` object, after `savePersona`:

```typescript
  launchTask: (taskId: string, req: LaunchRequest): Promise<void> =>
    ipcRenderer.invoke(IPC.launchTask, taskId, req),
  cancelTask: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.cancelTask, taskId),
  onTaskEvent: (cb: (e: TaskEvent) => void) =>
    ipcRenderer.on(IPC.taskEvent, (_e, ev: TaskEvent) => cb(ev)),
```

- [ ] **Step 2: Update the renderer's `window.bean` type declaration**

Edit `packages/app/src/renderer/bean.d.ts`:

1. Extend the type import:

```typescript
import type {
  RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project, Persona,
  LaunchRequest, TaskEvent,
} from "@bean/core";
```

2. Add to the `bean` interface, after `savePersona(p: Persona): Promise<void>;`:

```typescript
      launchTask(taskId: string, req: LaunchRequest): Promise<void>;
      cancelTask(taskId: string): Promise<void>;
      onTaskEvent(cb: (e: TaskEvent) => void): void;
```

- [ ] **Step 3: Verify the app package typechecks**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts
git commit -m "feat(app): add launchTask/cancelTask/onTaskEvent to the preload bridge"
```

---

### Task 6: Shared `formatElapsed` util (dedupe from `ConsolePanel`)

**Files:**
- Create: `packages/app/src/renderer/dashboard/format.ts`
- Modify: `packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `formatElapsed(ms: number): string` — consumed by `ConsolePanel.tsx` (this task)
  and Task 8 (`TaskMonitor.tsx`).

- [ ] **Step 1: Create the shared util**

Create `packages/app/src/renderer/dashboard/format.ts`:

```typescript
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 2: Update `ConsolePanel.tsx` to use it instead of its own copy**

In `packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx`:

Replace:
```typescript
import { useEffect, useRef, useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import type { TerminalLine } from "@bean/core";

type RunStatus = "idle" | "running" | "done" | "failed";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```
with:
```typescript
import { useEffect, useRef, useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import { formatElapsed } from "../format.js";
import type { TerminalLine } from "@bean/core";

type RunStatus = "idle" | "running" | "done" | "failed";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}
```

(`basename` stays local to `ConsolePanel.tsx` — it's not needed by `TaskMonitor`, which only
ever shows the project *name*, not its path.)

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: no errors (no test framework for renderer components — this is a pure refactor with
no behavior change, verified by typecheck + the manual walkthrough in Task 9).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/renderer/dashboard/format.ts packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx
git commit -m "refactor(app): extract formatElapsed into a shared dashboard util"
```

---

### Task 7: `ProjectsPanel` — selection, launch chips, inline prompt form

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx`
- Modify: `packages/app/src/renderer/dashboard.css`

**Interfaces:**
- Consumes: `Project` from `@bean/core`; `formatElapsed` unused here (Task 6 is for
  `ConsolePanel`/`TaskMonitor` only); receives `tasks`, `onLaunch`, `onCancel` props from
  `App.tsx` (Task 9).
- Produces: `ProjectsPanel({ projects, tasks, onLaunch, onCancel })` — renders the project
  list + LAUNCH chip row + inline prompt form + `<TaskMonitor>` (Task 8). `LaunchMode` type
  used for the chip click handler, imported from `@bean/core`.

Note: this task also changes `ProjectsPanel` to receive `projects` as a prop instead of
fetching them itself via `useEffect`/`window.bean.listProjects()` — `App.tsx` (Task 9) takes
over that fetch so it can pass the same `projects` list to the launch handler without a second
IPC round-trip. This is a small, necessary refactor of SP6's component, not scope creep: SP7's
launch flow needs the `Project` objects the panel is already displaying.

- [ ] **Step 1: Rewrite `ProjectsPanel.tsx`**

Replace the full contents of `packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx`
with:

```tsx
import { useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import { TaskMonitor } from "../TaskMonitor.js";
import type { Project, LaunchMode } from "@bean/core";
import type { TaskCard } from "../task-types.js";

const LAUNCH_CHIPS: { mode: LaunchMode; label: string; needsPrompt: boolean }[] = [
  { mode: "opencode", label: "opencode run", needsPrompt: true },
  { mode: "claude", label: "claude -p", needsPrompt: true },
  { mode: "open", label: "open", needsPrompt: false },
];

export function ProjectsPanel({
  projects,
  tasks,
  onLaunch,
  onCancel,
}: {
  projects: Project[];
  tasks: TaskCard[];
  onLaunch: (mode: LaunchMode, project: Project, prompt?: string) => void;
  onCancel: (taskId: string) => void;
}) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [formMode, setFormMode] = useState<LaunchMode | undefined>(undefined);
  const [prompt, setPrompt] = useState("");

  const selectedProject = projects.find((p) => p.path === selected);

  const pickChip = (mode: LaunchMode, project: Project): void => {
    const chip = LAUNCH_CHIPS.find((c) => c.mode === mode)!;
    if (!chip.needsPrompt) {
      onLaunch(mode, project);
      return;
    }
    setFormMode(mode);
    setPrompt("");
  };

  const confirmForm = (): void => {
    if (!selectedProject || !formMode) return;
    onLaunch(formMode, selectedProject, prompt);
    setFormMode(undefined);
  };

  if (projects.length === 0) {
    return (
      <div class="bean-panel bean-panel--wide">
        <PanelHeader title="Projects & Tasks" />
        <div class="bean-panel-empty">No projects configured — add entries to ~/.bean/projects.json</div>
      </div>
    );
  }

  return (
    <div class="bean-panel bean-panel--wide">
      <PanelHeader title="Projects & Tasks" />
      <div class="bean-projects-grid">
        <div class="bean-projects-list">
          {projects.map((p) => (
            <div
              key={p.path}
              class={`bean-projects-row${selected === p.path ? " bean-projects-row--selected" : ""}`}
              onClick={() => setSelected(p.path === selected ? undefined : p.path)}
            >
              <span class="bean-projects-name">{p.name}</span>
              <span class="bean-projects-path">{p.path}</span>
              {p.defaultSkill ? <span class="bean-chip">{p.defaultSkill}</span> : null}
            </div>
          ))}
        </div>
        <div class="bean-projects-launch">
          {selectedProject ? (
            <div>
              <div class="bean-launch-label">LAUNCH</div>
              <div class="bean-launch-chips">
                {LAUNCH_CHIPS.map((c) => (
                  <button
                    key={c.mode}
                    type="button"
                    class="bean-launch-chip"
                    onClick={() => pickChip(c.mode, selectedProject)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {formMode ? (
                <div class="bean-launch-form">
                  <textarea
                    class="bean-card-prompt"
                    value={prompt}
                    placeholder="What should it do?"
                    onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
                  />
                  <div class="bean-card-actions">
                    <button type="button" class="bean-btn" onClick={confirmForm}>Launch</button>
                    <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setFormMode(undefined)}>Cancel</button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div class="bean-panel-empty">Select a project to launch it.</div>
          )}
          <TaskMonitor tasks={tasks} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS for the new grid/chips/form**

Append to `packages/app/src/renderer/dashboard.css` (after the existing `/* --- projects
(SP6) --- */` block):

```css
/* --- projects launcher (SP7) --- */
.bean-projects-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  padding: 16px;
  overflow-y: auto;
}
.bean-projects-list { padding: 0; }
.bean-projects-row { cursor: pointer; }
.bean-projects-row--selected {
  border-color: var(--bean-accent);
  background: var(--bean-surface-2);
}
.bean-projects-launch {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bean-launch-label {
  font-size: 11px;
  color: var(--bean-text-dim);
  margin-bottom: 7px;
}
.bean-launch-chips { display: flex; gap: 7px; flex-wrap: wrap; }
.bean-launch-chip {
  font: 600 12px ui-monospace, monospace;
  color: var(--bean-text);
  background: transparent;
  border: 1px solid var(--bean-border);
  border-radius: 8px;
  padding: 6px 11px;
  cursor: pointer;
}
.bean-launch-chip:hover { border-color: var(--bean-accent); }
.bean-launch-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: errors referencing missing `../task-types.js` and `../TaskMonitor.js` — expected at
this point, resolved by Task 8. Confirm the *only* errors are those two missing-module errors
(no other typos).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx packages/app/src/renderer/dashboard.css
git commit -m "feat(app): add project selection, launch chips, and inline prompt form to ProjectsPanel"
```

---

### Task 8: `TaskMonitor` component + shared task types

**Files:**
- Create: `packages/app/src/renderer/dashboard/task-types.ts`
- Create: `packages/app/src/renderer/dashboard/TaskMonitor.tsx`
- Modify: `packages/app/src/renderer/dashboard.css`

**Interfaces:**
- Consumes: `TaskStatus`, `LaunchMode` from `@bean/core`; `formatElapsed` from Task 6.
- Produces: `TaskCard` interface (consumed by `ProjectsPanel.tsx` from Task 7 and `App.tsx`
  from Task 9); `TaskMonitor({ tasks, onCancel })` component.

- [ ] **Step 1: Create the shared `TaskCard` type**

Create `packages/app/src/renderer/dashboard/task-types.ts`:

```typescript
import type { LaunchMode, TaskStatus } from "@bean/core";

export interface TaskCard {
  taskId: string;
  mode: LaunchMode;
  projectName: string;
  prompt?: string;
  status: TaskStatus;
  pid?: number;
  exitCode?: number;
  message?: string;
  startedAt: number;
  cancelling?: boolean;
}

export const LAUNCH_MODE_LABEL: Record<LaunchMode, string> = {
  opencode: "opencode run",
  claude: "claude -p",
  open: "open",
};
```

- [ ] **Step 2: Create `TaskMonitor.tsx`**

Create `packages/app/src/renderer/dashboard/TaskMonitor.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { formatElapsed } from "./format.js";
import { LAUNCH_MODE_LABEL, type TaskCard } from "./task-types.js";

export function TaskMonitor({
  tasks,
  onCancel,
}: {
  tasks: TaskCard[];
  onCancel: (taskId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!tasks.some((t) => t.status === "running")) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tasks]);

  if (tasks.length === 0) return null;

  return (
    <div class="bean-task-list">
      {[...tasks].reverse().map((t) => (
        <div key={t.taskId} class="bean-task-card">
          <div class="bean-task-bar">
            <span class={`bean-task-dot bean-task-dot--${t.status}`} />
            <span class="bean-task-mode">{LAUNCH_MODE_LABEL[t.mode]}</span>
            <span class="bean-task-project">{t.projectName}</span>
            {t.pid !== undefined ? <span class="bean-task-pid">pid {t.pid}</span> : null}
            <span class="bean-console-spacer" />
            <span class="bean-console-time">{formatElapsed(now - t.startedAt)}</span>
            {t.status === "running" ? (
              <button
                type="button"
                class="bean-btn bean-btn--ghost bean-task-cancel"
                disabled={t.cancelling}
                onClick={() => onCancel(t.taskId)}
              >
                Cancel
              </button>
            ) : null}
          </div>
          <div class="bean-task-progress">
            <div class={`bean-task-progress-fill${t.status === "running" ? " bean-task-progress-fill--running" : ""}`} />
          </div>
          {t.status === "failed" && t.message ? (
            <div class="bean-task-message">{t.message}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add CSS for task cards**

Append to `packages/app/src/renderer/dashboard.css` (after the launcher CSS added in Task 7):

```css
.bean-task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}
.bean-task-card {
  background: var(--bean-surface-2);
  border: 1px solid var(--bean-border);
  border-radius: 10px;
  padding: 11px 12px;
}
.bean-task-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--bean-text-dim);
  margin-bottom: 8px;
}
.bean-task-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.bean-task-dot--running { background: oklch(0.66 0.15 48); animation: bean-console-blink 1.1s infinite; }
.bean-task-dot--done { background: oklch(0.7 0.14 155); }
.bean-task-dot--failed { background: oklch(0.66 0.16 30); }
.bean-task-dot--cancelled { background: var(--bean-text-dim); }
.bean-task-mode { font-weight: 600; color: var(--bean-text); }
.bean-task-project { color: var(--bean-text-dim); }
.bean-task-pid { font: 11px ui-monospace, monospace; }
.bean-task-cancel { padding: 3px 9px; font-size: 11px; }
.bean-task-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--bean-border);
  overflow: hidden;
}
.bean-task-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--bean-text-dim);
  width: 100%;
}
.bean-task-progress-fill--running {
  background: oklch(0.66 0.15 48);
  animation: bean-task-progress 1.4s ease-in-out infinite alternate;
}
.bean-task-message {
  margin-top: 8px;
  font: 11px ui-monospace, monospace;
  color: #e5484d;
  white-space: pre-wrap;
  word-break: break-word;
}
@keyframes bean-task-progress {
  from { transform: translateX(-40%); }
  to { transform: translateX(40%); }
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: errors now only in `App.tsx` (still passing the old `<ProjectsPanel />` with no
props) — resolved by Task 9. Confirm `ProjectsPanel.tsx` and `TaskMonitor.tsx` themselves
report no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/dashboard/task-types.ts packages/app/src/renderer/dashboard/TaskMonitor.tsx packages/app/src/renderer/dashboard.css
git commit -m "feat(app): add TaskMonitor component and shared TaskCard type"
```

---

### Task 9: Wire it all up in `App.tsx`

**Files:**
- Modify: `packages/app/src/renderer/dashboard/App.tsx`

**Interfaces:**
- Consumes: `window.bean.launchTask/cancelTask/onTaskEvent/listProjects` (Task 5), `TaskCard`
  (Task 8), `ProjectsPanel` (Task 7), `LaunchMode`/`TaskEvent`/`Project` from `@bean/core`.
- Produces: fully wired dashboard — this is the final integration task before manual
  verification.

- [ ] **Step 1: Update `App.tsx`**

In `packages/app/src/renderer/dashboard/App.tsx`:

1. Extend imports — replace:
```tsx
import type { ChatTurn, RouteSuggestion, RunEvent } from "@bean/core";
```
with:
```tsx
import type { ChatTurn, RouteSuggestion, RunEvent, Project, LaunchMode, TaskEvent } from "@bean/core";
import type { TaskCard } from "./task-types.js";
```

2. Add new state (after the existing `const [startedAt, setStartedAt] = ...` line):

```tsx
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
```

3. In the existing `useEffect(() => { ... }, [])` that wires up `window.bean` listeners, add
   (after `window.bean.onDashboardDroppedUrl(setDroppedUrl);`):

```tsx
    void window.bean.listProjects().then(setProjects);
    window.bean.onTaskEvent((ev: TaskEvent) => {
      setTasks((prev) => prev.map((t) => (t.taskId === ev.taskId ? { ...t, ...ev } : t)));
    });
```

4. Add the launch/cancel handlers (after `const runSkillProposal = ...` function, before the
   `return (`):

```tsx
  function capTasks(list: TaskCard[]): TaskCard[] {
    if (list.length <= 20) return list;
    const idx = list.findIndex((t) => t.status !== "running");
    return idx === -1 ? list : [...list.slice(0, idx), ...list.slice(idx + 1)];
  }

  const launchTask = (mode: LaunchMode, project: Project, prompt?: string): void => {
    const taskId = crypto.randomUUID();
    setTasks((prev) => capTasks([
      ...prev,
      { taskId, mode, projectName: project.name, prompt, status: "running", startedAt: Date.now() },
    ]));
    void window.bean.launchTask(taskId, { mode, projectPath: project.path, projectName: project.name, prompt });
  };

  const cancelTask = (taskId: string): void => {
    setTasks((prev) => prev.map((t) => (t.taskId === taskId ? { ...t, cancelling: true } : t)));
    void window.bean.cancelTask(taskId);
  };
```

5. Replace the render's `<ProjectsPanel />` with:
```tsx
        <ProjectsPanel projects={projects} tasks={tasks} onLaunch={launchTask} onCancel={cancelTask} />
```

- [ ] **Step 2: Run the full validation gate**

Run: `pnpm test`
Expected: all packages' test suites PASS (0 failures).

Run: `pnpm typecheck`
Expected: no errors in either package.

Run: `pnpm --filter @bean/app build`
Expected: esbuild completes with no errors (confirms the renderer bundle — which must stay
Node-free per `.memory/convention-core-is-electron-free.md`'s SP3-established rule — still
builds; `launcher.ts`'s `node:child_process` import is never pulled in because the renderer
only imports its *types*).

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/renderer/dashboard/App.tsx
git commit -m "feat(app): wire ProjectsPanel launch/cancel and task list into App"
```

---

### Task 10: Manual verification walkthrough + playbook update

**Files:**
- Modify: `docs/superpowers/bean-redesign-playbook.md` (status ledger)

This task has no automated test — it's the manual GUI walkthrough the playbook's §2 workflow
requires as the final step, mirroring SP3/SP4/SP6's precedent. If your environment has no
GUI-automation/screenshot tool available, follow SP3/SP4's substitute approach instead (static
code review of the wiring + a clean `pnpm dev` process start with no crash) and note that
explicitly in your report — do not skip reporting which path you took.

- [ ] **Step 1: Start the app**

Run: `pnpm dev`
Expected: main/gpu/renderer/network processes start with no crash; avatar window appears.

- [ ] **Step 2: Open the dashboard and select a project**

Double-click the avatar to open the dashboard. In the Projects & Tasks panel, click a project
row.
Expected: row highlights (selected style), a LAUNCH row with 3 chips (`opencode run`, `claude
-p`, `open`) appears next to it.

- [ ] **Step 3: Launch `open`**

Click the `open` chip (requires `zed` on `PATH`; if unavailable, confirm the task card still
reaches `"failed"` with an `ENOENT`-style message rather than hanging — this itself validates
the error path).
Expected: a task card appears immediately with a `running` dot, `pid N`, and an indeterminate
progress bar; shortly after, it settles to `done` (or `failed` with a one-line message if
`zed` isn't installed) and the progress bar stops animating.

- [ ] **Step 4: Launch `opencode run` with a prompt**

Click `opencode run`, type a short prompt (e.g. "say hello") in the form, click Launch.
Expected: a second task card appears and progresses `running` → `done`/`failed`
independently of the first (confirms multi-task concurrency works, not just sequential).

- [ ] **Step 5: Cancel a running task**

Launch a longer-running `opencode run`/`claude -p` prompt, click its `Cancel` button while
`running`.
Expected: the Cancel button disables immediately; shortly after, the card's dot/status
reaches `cancelled` (not `failed`).

- [ ] **Step 6: Confirm the chat/console flow is untouched**

Use the Command Bar or Chat panel to trigger a normal skill run via the existing propose/
confirm flow.
Expected: behaves exactly as before (ConsolePanel shows it, unaffected by any
Projects-panel-launched tasks running concurrently).

- [ ] **Step 7: Confirm the 20-task cap**

Launch enough tasks (e.g. 25 quick `open` calls) to exceed the cap.
Expected: the monitor list never exceeds ~20 cards; older *finished* cards are evicted first,
any still-`running` card is never evicted.

- [ ] **Step 8: Update the playbook status ledger**

Edit `docs/superpowers/bean-redesign-playbook.md`'s §1 table, row for SP7 — change:

```
| 7 | Multi-launcher + task monitor: `opencode run` / `claude -p` / `open` / `shell` per project, plus a live subprocess monitor. Split out of SP6 during brainstorming pending a design rethink; needs its own spec/plan. | — | — | ⬜ not started |
```

to:

```
| 7 | Multi-launcher + task monitor: `opencode run` / `claude -p` / `open` (zed) per project, plus a live multi-task subprocess monitor with cancel support. `shell` mode dropped (future SP). | `specs/2026-07-01-bean-multi-launcher-task-monitor-design.md` | `plans/2026-07-01-bean-multi-launcher-task-monitor.md` | ✅ done + reviewed |
```

(Adjust the status text if your manual walkthrough had to substitute the SP3/SP4-style
code-review fallback for any step — be specific about which steps were and weren't observed
directly, same as the existing ledger entries do.)

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/bean-redesign-playbook.md
git commit -m "docs(sp7): mark multi-launcher + task monitor done"
```
