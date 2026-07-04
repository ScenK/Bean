# SP7: Multi-launcher + Task Monitor — Design

**Status:** approved, ready for planning.
**Branch:** `claude/heuristic-kilby-6ce399`.
**Depends on:** SP6 (Projects panel, `listProjects` IPC) — this SP extends `ProjectsPanel.tsx` in place.

## 1. Purpose & scope

The "Bean Concept" mockup's Projects & Tasks panel has two halves: a project list (shipped in
SP6) and a **launcher + live subprocess monitor** (this SP). From the Projects panel, a user
selects a project, picks a launch mode, optionally types a prompt, and confirms. The spawned
process becomes a **task**: a summary card (status dot, mode, project, pid, elapsed timer,
progress bar) in a capped, session-only list. Running tasks can be cancelled.

**Launch modes (3, not the mockup's 4):**
- `opencode run` — same command shape as the existing chat-driven run (`opencode run <prompt>
  --dir <path>`), but triggered directly from the Projects panel instead of via chat routing.
- `claude -p` — runs `claude -p <prompt>` in the project directory.
- `open` — runs `zed <path>` (hardcoded to the Zed editor CLI, no prompt).

`shell` (the mockup's 4th chip) is **dropped from this SP entirely** — its design (one-shot
vs. interactive PTY) isn't settled; it becomes a future, not-yet-scoped SP.

**Concurrency:** multiple tasks can run at once (not just one global run). Each launch gets
its own id and its own subprocess; the monitor shows all of them.

**Output detail:** summary cards only — status, pid, elapsed, exit code, and (on failure only)
a short one-line message. No stdout/stderr log view for these tasks; that's why the mockup's
task card doesn't show one either.

**Relationship to the existing chat run flow (SP2/SP3):** intentionally kept **separate**.
Chat's `ProposalCard → confirm → ConsolePanel` single-run flow is untouched — no changes to
`runner.ts`, `RunEvent`, or `ConsolePanel.tsx`. This SP adds a parallel, independent path for
Projects-panel-triggered launches.

## 2. Core: `packages/core/src/launcher.ts` (new file)

Node-only (`node:child_process`) — imported only by `packages/app/src/ipc.ts` (main process).
The renderer only ever imports this module's **types**, the same way `App.tsx` already
type-imports `RunEvent`/`RouteSuggestion` from the `@bean/core` barrel today — type-only
imports are erased at compile time and never pull `node:child_process` into the esbuild
`platform: "browser"` renderer bundle, so no new Node-free subpath (like `terminal.ts`/
`persona.ts`) is needed here.

```ts
export type LaunchMode = "opencode" | "claude" | "open";
export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export interface LaunchRequest {
  mode: LaunchMode;
  projectPath: string;
  projectName: string;
  prompt?: string; // required for "opencode"/"claude", absent/ignored for "open"
}

export interface TaskEvent {
  taskId: string;
  status: TaskStatus;
  pid?: number;       // set once on the initial "running" event
  exitCode?: number;  // set on "done"/"failed"
  message?: string;   // stderr tail (last ~500 chars), only set when status === "failed"
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

export type LaunchSpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string },
) => import("node:child_process").ChildProcess;

export interface LaunchHandle {
  child: import("node:child_process").ChildProcess;
  cancel: () => void;
}

export function launchTask(
  taskId: string,
  req: LaunchRequest,
  onEvent: (event: TaskEvent) => void,
  spawnFn?: LaunchSpawnFn,
): LaunchHandle;
```

**Behavior:**
- Default `spawnFn` calls Node's real `spawn(command, args, { ...options, stdio: ["ignore",
  "ignore", "pipe"] })` — stdin/stdout are OS-discarded immediately (no backpressure risk,
  and sidesteps the same "opencode blocks on an open stdin pipe" issue `runner.ts` already
  hit, per `.memory/safety-runopencode-stdin-hang.md` — ignoring stdin outright is a stronger
  fix than `stdin.end()` here since there's no display need for stdout anyway). `stderr` stays
  piped so a failure message can be captured.
- Emits `{ taskId, status: "running", pid: child.pid }` synchronously after spawn.
- Buffers stderr into a rolling ~500-char tail (`(tail + chunk).slice(-500)`), never stored
  beyond that bound.
- `cancel()` sets an internal `cancelled` flag and calls `child.kill()`.
- On `close`: emits `{ taskId, status: cancelled ? "cancelled" : (code === 0 ? "done" :
  "failed"), exitCode: code ?? undefined, message: status === "failed" ? (tail || undefined) :
  undefined }`.
- On `error` (e.g. `ENOENT` — command not found): emits `{ taskId, status: cancelled ?
  "cancelled" : "failed", message: cancelled ? undefined : err.message }` once (guarded the
  same way `runner.ts` guards its `settled` flag against a double resolve from both `error`
  and `close` — and checking `cancelled` here too, since `child.kill()` can surface as an
  `error` instead of a `close` on some signal paths; without this check a cancelled task could
  misreport as `"failed"`).

## 3. IPC (`packages/app/src/channels.ts`, `ipc.ts`, `preload.ts`, `bean.d.ts`)

**`channels.ts`** — add three entries to the `IPC` constant:
```ts
launchTask: "bean:launch-task",
cancelTask: "bean:cancel-task",
taskEvent: "bean:task-event",
```

**`ipc.ts`** — inside `registerIpc`, a closure-local map of *currently running* tasks only
(entries removed the instant their terminal event fires — no persistence, no leak across the
app's lifetime):

```ts
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  // ...existing fields...
  spawnLaunch?: LaunchSpawnFn; // optional DI hook for tests; defaults inside launchTask
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): void {
  // ...existing handlers...
  const tasks = new Map<string, LaunchHandle>();
  ipcMain.handle(IPC.launchTask, (_e, taskId: string, req: LaunchRequest) => {
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
  });
  ipcMain.handle(IPC.cancelTask, (_e, taskId: string) => { tasks.get(taskId)?.cancel(); });
}
```

**`preload.ts`** — add three bridge methods matching the existing `run`/`onRunEvent` shape:
```ts
launchTask: (taskId: string, req: LaunchRequest) => ipcRenderer.invoke(IPC.launchTask, taskId, req),
cancelTask: (taskId: string) => ipcRenderer.invoke(IPC.cancelTask, taskId),
onTaskEvent: (cb: (ev: TaskEvent) => void) => ipcRenderer.on(IPC.taskEvent, (_e, ev) => cb(ev)),
```

**`bean.d.ts`** — add matching type signatures to the `window.bean` interface.

## 4. Renderer

**`App.tsx`** — lift task-list state next to the existing `currentRun`/`terminal`/`runStatus`
state (same "App owns IPC-event-driven state, panels are presentational" pattern already used
for the run flow):

```ts
interface TaskCard {
  taskId: string;
  mode: LaunchMode;
  projectName: string;
  prompt?: string;
  status: TaskStatus;
  pid?: number;
  exitCode?: number;
  message?: string;
  startedAt: number;
}

const [tasks, setTasks] = useState<TaskCard[]>([]);

useEffect(() => {
  window.bean.onTaskEvent((ev: TaskEvent) => {
    setTasks((prev) => prev.map((t) => (t.taskId === ev.taskId ? { ...t, ...ev } : t)));
  });
}, []);

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

const cancelTask = (taskId: string): void => { void window.bean.cancelTask(taskId); };
```
`capTasks` only evicts the oldest **non-running** entry when over the 20-card cap; a run of
>20 concurrently-running tasks is allowed to briefly exceed the cap rather than dropping live
work — this is a display cap on history, not a concurrency limit.

Render: `<ProjectsPanel projects={...} tasks={tasks} onLaunch={launchTask} onCancel={cancelTask} />`.

**`ProjectsPanel.tsx`** — extends the SP6 read-only list:
- Row click sets local `selected: string | undefined` (project path). Selected row shows a
  `LAUNCH` chip row: three hardcoded chips — `opencode run` / `claude -p` / `open` (a literal
  3-entry array in the component; not worth a shared constant/subpath module for 3 strings).
- Clicking `opencode run` or `claude -p` toggles a small inline `LaunchForm` (new component:
  textarea + Confirm/Cancel buttons, same local-state shape as `ProposalCard`'s prompt
  textarea) below the chip row. Confirm calls `onLaunch(mode, project, prompt)` and closes the
  form; Cancel just closes it.
- Clicking `open` calls `onLaunch("open", project)` immediately — no form.
- Below the project list: a new `TaskMonitor` sub-component maps `tasks` (newest first) to
  cards:
  - Status dot colored by `TaskStatus` (reusing the same color-by-state CSS pattern as
    `ConsolePanel`'s `bean-console-chip--{status}`).
  - Mode label (`opencode run` / `claude -p` / `open`) + project name.
  - `pid {n}` once known.
  - Elapsed timer — `formatElapsed` is extracted from `ConsolePanel.tsx` into a small shared
    util module (`packages/app/src/renderer/dashboard/format.ts`) since it now has two
    consumers; `ConsolePanel.tsx` is updated to import it instead of defining its own copy.
  - An indeterminate CSS-animated progress bar while `status === "running"` (matches the
    mockup's `animation: prog 6s ease-in-out infinite alternate` — no real percentage, since
    none of the 3 commands report progress).
  - A one-line red `message` when `status === "failed"`.
  - A `Cancel` button, shown only while `running`; clicking it calls `onCancel(taskId)` and
    disables itself locally until the real terminal event arrives (avoids a double-click
    double-`cancel()` call, doesn't fabricate a status the backend hasn't confirmed yet).

## 5. Testing plan

- **`packages/core/__test__/launcher.test.ts`** (new, TDD): `launchCommand` for all 3 modes
  (pure mapping, trivial assertions). `launchTask` using a fake `spawnFn` returning a fake
  `ChildProcess` (EventEmitter-based, matching `runner.test.ts`'s existing fake style),
  covering: running→done (exit code 0), running→failed (non-zero exit, message = stderr
  tail truncated to the last 500 chars), running→cancelled (`handle.cancel()` called before
  `close` fires, final status is `"cancelled"` not `"failed"` regardless of exit code),
  spawn `error` event (status `"failed"`, message = error message, no double-emit if `close`
  also fires), cancel-then-`error` (status `"cancelled"` not `"failed"`, no message), and a
  no-`stdin`/no-`stderr`-property guard (mirrors the existing
  `runner.test.ts` "does not throw when the spawned child has no stdin" case).
- **`packages/app/__test__/ipc.test.ts`** (extend): `launchTask`/`cancelTask` handlers via
  `deps.spawnLaunch` fake — asserts the event is forwarded to `sender().send(IPC.taskEvent,
  ev)`, the internal map entry is removed after a terminal event, and `cancelTask` calls
  `handle.cancel()` for a known id and no-ops for an unknown one.
- **Renderer** (`ProjectsPanel`/`TaskMonitor`/`LaunchForm`/`App.tsx` wiring): no test
  framework for renderer UI, per the playbook's conventions — verified manually via `pnpm
  dev`: select a project, launch each of the 3 modes, observe each card's full lifecycle
  (running → done/failed), trigger a failure (e.g. an intentionally-missing command or bad
  prompt) to confirm the message line renders, cancel a running task and confirm it reaches
  `"cancelled"`, and launch >20 tasks to confirm the oldest *finished* one is evicted while
  running ones are not. This is the SP7 manual-verification checklist for the plan's final
  task, same shape as SP3/SP4/SP6's.

## 6. Out of scope for SP7

- `shell` launch mode — dropped entirely; a future, not-yet-designed SP.
- Any stdout/stderr log viewer per task — summary cards only, matching the mockup.
- Disk persistence of task history — in-memory, session-only (cleared on dashboard window
  close/reopen, same as SP3's console).
- Configurable editor command for `open` — hardcoded to `zed`.
- Unifying with the chat/`ProposalCard`/`ConsolePanel` single-run flow — stays a fully
  separate path; no changes to `runner.ts`, `RunEvent`, or `ConsolePanel.tsx`.
- Cross-window task references — tasks live only in the dashboard window's renderer state.
