# Todo-Driven Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-routine consume-once todo queues: a routine marked todo-driven runs its step pipeline once per queued todo and skips its scheduled run when the queue is empty.

**Architecture:** Todos live in a new `todos` table in `~/.bean/bean.db` behind a pure `todo-store.ts` in `@bean/core`. `runRoutine` gains an injected `todos` dep and, for `todoDriven` routines, loops the whole step pipeline per pending todo. The scheduler skips empty-queue fires. Chat capture is a confirm-first `propose_todo` tool in `converse()` (chat window card + chatops card), mirroring `propose_note` exactly.

**Tech Stack:** TypeScript ESM (`.js` import extensions, `import type`), `node:sqlite` `DatabaseSync`, vitest, Preact renderer, Electron IPC.

**Spec:** `docs/superpowers/specs/2026-07-15-todo-driven-routines-design.md`

## Global Constraints

- `@bean/core` stays Electron-free and dependency-injected (`.memory/convention-core-is-electron-free.md`).
- IPC channel names defined once in `packages/app/src/channels.ts`, never string-literaled (`.memory/convention-ipc-channels.md`).
- Renderer imports core **values** only from node-free subpaths; type-only barrel imports are fine (`.memory/convention-renderer-imports-node-free-subpaths.md`).
- `strict` + `noUncheckedIndexedAccess` are on — array indexing yields `T | undefined`.
- Routine runs get NO propose_* tools; `propose_todo` is chat/chatops only.
- Old `~/.bean/routines/*.json` files (no `todoDriven` field) must stay valid — no migration.
- Validation gate per task: `pnpm test && pnpm typecheck` both exit 0 before commit claims.
- Run single-package tests with `pnpm --filter @bean/core exec vitest run __test__/<file>.test.ts` (or `@bean/app`).

---

### Task 1: `todo-store.ts` — SQLite-backed todo queue in core

**Files:**
- Modify: `packages/core/src/db.ts` (add `todos` table to `SCHEMA`)
- Create: `packages/core/src/todo-store.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/__test__/todo-store.test.ts`

**Interfaces:**
- Consumes: `openDb(file)` / `closeDb(file)` from `db.ts`.
- Produces (all exported from `@bean/core`):
  - `interface TodoItem { id: string; routine: string; text: string; status: TodoStatus; createdAt: string; finishedAt?: string; resultSummary?: string; order: number }`
  - `type TodoStatus = "pending" | "running" | "done" | "failed"`
  - `addTodo(file: string, routine: string, text: string, newId?: () => string, now?: () => Date): Promise<TodoItem>`
  - `listTodos(file: string, routine: string): Promise<TodoItem[]>` (ordered by `order` ASC; all statuses)
  - `listAllTodos(file: string): Promise<TodoItem[]>`
  - `updateTodoStatus(file: string, id: string, status: TodoStatus, resultSummary?: string, now?: () => Date): Promise<void>`
  - `editTodoText(file: string, id: string, text: string): Promise<void>` (throws unless the item is `pending`)
  - `reorderTodo(file: string, id: string, newOrder: number): Promise<void>`
  - `deleteTodo(file: string, id: string): Promise<void>`
  - `clearFinishedTodos(file: string, routine: string): Promise<void>` (deletes `done` + `failed`)
  - `retryTodo(file: string, id: string): Promise<void>` (`failed` → `pending`, clears `finishedAt`/`resultSummary`)
  - `recoverInterruptedTodos(file: string, now?: () => Date): Promise<number>` (`running` → `failed` with `resultSummary: "interrupted"`, returns count)
  - `renameTodosRoutine(file: string, from: string, to: string): Promise<void>`
  - `deleteTodosForRoutine(file: string, routine: string): Promise<void>`

- [ ] **Step 1: Add the table to `SCHEMA` in `db.ts`**

Append inside the `SCHEMA` template string in `packages/core/src/db.ts` (after the `chatops_turns` index):

```sql
CREATE TABLE IF NOT EXISTS todos (
  id             TEXT PRIMARY KEY,
  routine        TEXT NOT NULL,
  text           TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  finished_at    TEXT,
  result_summary TEXT,
  ord            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_routine ON todos(routine);
```

(`ord`, not `order` — `order` is a SQL keyword.) Note: `CREATE TABLE IF NOT EXISTS` inside the shared SCHEMA means existing bean.db files pick the table up on next open — no migration step needed.

- [ ] **Step 2: Write the failing tests**

`packages/core/__test__/todo-store.test.ts` — follow the existing note-store test's temp-dir + `closeDb` teardown pattern (read `packages/core/__test__/note-store.test.ts` first and copy its setup/teardown shape):

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTodo, listTodos, listAllTodos, updateTodoStatus, editTodoText, reorderTodo,
  deleteTodo, clearFinishedTodos, retryTodo, recoverInterruptedTodos,
  renameTodosRoutine, deleteTodosForRoutine, closeDb,
} from "../src/index.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-todo-"));
  file = join(dir, "bean.db");
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

describe("todo-store", () => {
  it("adds pending todos with increasing order and lists them in order", async () => {
    const a = await addTodo(file, "nightly", "task A");
    const b = await addTodo(file, "nightly", "task B");
    expect(a.status).toBe("pending");
    expect(b.order).toBeGreaterThan(a.order);
    expect((await listTodos(file, "nightly")).map((t) => t.text)).toEqual(["task A", "task B"]);
  });

  it("scopes listTodos by routine but listAllTodos returns everything", async () => {
    await addTodo(file, "nightly", "a");
    await addTodo(file, "weekly", "b");
    expect(await listTodos(file, "nightly")).toHaveLength(1);
    expect(await listAllTodos(file)).toHaveLength(2);
  });

  it("rejects empty text", async () => {
    await expect(addTodo(file, "nightly", "   ")).rejects.toThrow();
  });

  it("stamps finishedAt and resultSummary on done/failed, not on running", async () => {
    const t = await addTodo(file, "nightly", "task");
    await updateTodoStatus(file, t.id, "running");
    let [row] = await listTodos(file, "nightly");
    expect(row!.status).toBe("running");
    expect(row!.finishedAt).toBeUndefined();
    await updateTodoStatus(file, t.id, "done", "all good");
    [row] = await listTodos(file, "nightly");
    expect(row!.status).toBe("done");
    expect(row!.finishedAt).toBeTruthy();
    expect(row!.resultSummary).toBe("all good");
  });

  it("edits pending text but refuses on finished items", async () => {
    const t = await addTodo(file, "nightly", "old");
    await editTodoText(file, t.id, "new");
    expect((await listTodos(file, "nightly"))[0]!.text).toBe("new");
    await updateTodoStatus(file, t.id, "done");
    await expect(editTodoText(file, t.id, "nope")).rejects.toThrow();
  });

  it("reorders, deletes, and clears finished", async () => {
    const a = await addTodo(file, "nightly", "a");
    const b = await addTodo(file, "nightly", "b");
    await reorderTodo(file, b.id, a.order); // swap semantics not required; just persist newOrder
    await updateTodoStatus(file, a.id, "done");
    await clearFinishedTodos(file, "nightly");
    expect((await listTodos(file, "nightly")).map((t) => t.id)).toEqual([b.id]);
    await deleteTodo(file, b.id);
    expect(await listTodos(file, "nightly")).toHaveLength(0);
  });

  it("retryTodo resets a failed item to pending", async () => {
    const t = await addTodo(file, "nightly", "task");
    await updateTodoStatus(file, t.id, "failed", "boom");
    await retryTodo(file, t.id);
    const [row] = await listTodos(file, "nightly");
    expect(row!.status).toBe("pending");
    expect(row!.finishedAt).toBeUndefined();
    expect(row!.resultSummary).toBeUndefined();
  });

  it("retryTodo refuses on non-failed items", async () => {
    const t = await addTodo(file, "nightly", "task");
    await expect(retryTodo(file, t.id)).rejects.toThrow();
  });

  it("recoverInterruptedTodos fails stuck running items", async () => {
    const t = await addTodo(file, "nightly", "task");
    await updateTodoStatus(file, t.id, "running");
    expect(await recoverInterruptedTodos(file)).toBe(1);
    const [row] = await listTodos(file, "nightly");
    expect(row!.status).toBe("failed");
    expect(row!.resultSummary).toBe("interrupted");
  });

  it("renames and cascades deletes by routine", async () => {
    await addTodo(file, "old-name", "task");
    await renameTodosRoutine(file, "old-name", "new-name");
    expect(await listTodos(file, "new-name")).toHaveLength(1);
    await deleteTodosForRoutine(file, "new-name");
    expect(await listAllTodos(file)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/todo-store.test.ts`
Expected: FAIL — the imports don't exist yet.

- [ ] **Step 4: Implement `packages/core/src/todo-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";

export type TodoStatus = "pending" | "running" | "done" | "failed";

/** One consume-once queue item owned by a todo-driven routine. Plain text only — the
 * routine's steps supply skill/project/model; the text is the task context. */
export interface TodoItem {
  id: string;
  routine: string;
  text: string;
  status: TodoStatus;
  createdAt: string;   // ISO
  finishedAt?: string; // ISO, set on done/failed
  resultSummary?: string;
  order: number;
}

interface TodoRow {
  id: string; routine: string; text: string; status: string;
  created_at: string; finished_at: string | null; result_summary: string | null; ord: number;
}

const SELECT = "SELECT id, routine, text, status, created_at, finished_at, result_summary, ord FROM todos";

function toItem(r: TodoRow): TodoItem {
  return {
    id: r.id, routine: r.routine, text: r.text, status: r.status as TodoStatus,
    createdAt: r.created_at, finishedAt: r.finished_at ?? undefined,
    resultSummary: r.result_summary ?? undefined, order: r.ord,
  };
}

export async function addTodo(
  file: string, routine: string, text: string,
  newId: () => string = randomUUID, now: () => Date = () => new Date(),
): Promise<TodoItem> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("todo text is required");
  if (!routine.trim()) throw new Error("todo routine is required");
  const db = openDb(file);
  const item: TodoItem = { id: newId(), routine, text: trimmed, status: "pending", createdAt: now().toISOString(), order: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const max = db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM todos WHERE routine = ?").get(routine) as unknown as { m: number };
    item.order = max.m + 1;
    db.prepare("INSERT INTO todos (id, routine, text, status, created_at, ord) VALUES (?, ?, ?, ?, ?, ?)")
      .run(item.id, item.routine, item.text, item.status, item.createdAt, item.order);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return item;
}

export async function listTodos(file: string, routine: string): Promise<TodoItem[]> {
  const rows = openDb(file).prepare(`${SELECT} WHERE routine = ? ORDER BY ord ASC, created_at ASC`)
    .all(routine) as unknown as TodoRow[];
  return rows.map(toItem);
}

export async function listAllTodos(file: string): Promise<TodoItem[]> {
  const rows = openDb(file).prepare(`${SELECT} ORDER BY routine ASC, ord ASC`).all() as unknown as TodoRow[];
  return rows.map(toItem);
}

export async function updateTodoStatus(
  file: string, id: string, status: TodoStatus, resultSummary?: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const finished = status === "done" || status === "failed";
  openDb(file).prepare("UPDATE todos SET status = ?, finished_at = ?, result_summary = ? WHERE id = ?")
    .run(status, finished ? now().toISOString() : null, resultSummary ?? null, id);
}

export async function editTodoText(file: string, id: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("todo text is required");
  const changed = openDb(file).prepare("UPDATE todos SET text = ? WHERE id = ? AND status = 'pending'").run(trimmed, id);
  if (changed.changes === 0) throw new Error("only pending todos can be edited");
}

export async function reorderTodo(file: string, id: string, newOrder: number): Promise<void> {
  openDb(file).prepare("UPDATE todos SET ord = ? WHERE id = ?").run(newOrder, id);
}

export async function deleteTodo(file: string, id: string): Promise<void> {
  openDb(file).prepare("DELETE FROM todos WHERE id = ?").run(id);
}

export async function clearFinishedTodos(file: string, routine: string): Promise<void> {
  openDb(file).prepare("DELETE FROM todos WHERE routine = ? AND status IN ('done', 'failed')").run(routine);
}

export async function retryTodo(file: string, id: string): Promise<void> {
  const changed = openDb(file)
    .prepare("UPDATE todos SET status = 'pending', finished_at = NULL, result_summary = NULL WHERE id = ? AND status = 'failed'")
    .run(id);
  if (changed.changes === 0) throw new Error("only failed todos can be retried");
}

/** Startup recovery: anything still `running` was interrupted by a quit/crash mid-run.
 * Marked failed ("interrupted") — visible and retryable, never silently lost. */
export async function recoverInterruptedTodos(file: string, now: () => Date = () => new Date()): Promise<number> {
  const changed = openDb(file)
    .prepare("UPDATE todos SET status = 'failed', finished_at = ?, result_summary = 'interrupted' WHERE status = 'running'")
    .run(now().toISOString());
  return Number(changed.changes);
}

export async function renameTodosRoutine(file: string, from: string, to: string): Promise<void> {
  openDb(file).prepare("UPDATE todos SET routine = ? WHERE routine = ?").run(to, from);
}

export async function deleteTodosForRoutine(file: string, routine: string): Promise<void> {
  openDb(file).prepare("DELETE FROM todos WHERE routine = ?").run(routine);
}
```

Add to `packages/core/src/index.ts` next to the note-store export line:

```ts
export * from "./todo-store.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/todo-store.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Full gate and commit**

Run: `pnpm test && pnpm typecheck` — both exit 0.

```bash
git add packages/core/src/db.ts packages/core/src/todo-store.ts packages/core/src/index.ts packages/core/__test__/todo-store.test.ts
git commit -m "feat(core): SQLite-backed todo store for todo-driven routines"
```

---

### Task 2: `Routine.todoDriven` flag + validator

**Files:**
- Modify: `packages/core/src/routine-store.ts`
- Test: `packages/core/__test__/routine-store.test.ts` (add cases to the existing file)

**Interfaces:**
- Produces: `Routine` gains optional `todoDriven?: boolean`. Absent/false = existing behavior. `isValidRoutine` accepts it.

- [ ] **Step 1: Add failing validator tests**

Append to the existing `describe` block in `packages/core/__test__/routine-store.test.ts` (read the file first; reuse its existing valid-routine fixture helper if one exists, otherwise inline):

```ts
it("accepts todoDriven boolean and rejects non-boolean", () => {
  const base = {
    name: "r", enabled: true, cron: "0 2 * * *",
    steps: [{ kind: "chat" as const, instruction: "do it" }], sinks: {},
  };
  expect(isValidRoutine({ ...base, todoDriven: true })).toBe(true);
  expect(isValidRoutine({ ...base, todoDriven: false })).toBe(true);
  expect(isValidRoutine(base)).toBe(true); // old files: field absent
  expect(isValidRoutine({ ...base, todoDriven: "yes" })).toBe(false);
});
```

- [ ] **Step 2: Run to verify the rejection case fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/routine-store.test.ts`
Expected: FAIL on `todoDriven: "yes"` (currently unknown fields are ignored, so it returns true).

- [ ] **Step 3: Implement**

In `packages/core/src/routine-store.ts`, add to the `Routine` interface after `cron`:

```ts
  /** true = the steps are a pipeline run once per queued todo; the scheduled run is
   * skipped entirely while the routine's queue has no pending items. */
  todoDriven?: boolean;
```

In `isValidRoutine`, after the `enabled`/`cron` check line, add:

```ts
  if (r.todoDriven !== undefined && typeof r.todoDriven !== "boolean") return false;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/routine-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routine-store.ts packages/core/__test__/routine-store.test.ts
git commit -m "feat(core): todoDriven flag on Routine"
```

---

### Task 3: `routine-runner.ts` — per-todo pipeline execution

**Files:**
- Modify: `packages/core/src/routine-runner.ts`
- Test: `packages/core/__test__/routine-runner.test.ts` (add a `describe("todo-driven", ...)` block)

**Interfaces:**
- Consumes: `TodoItem`, `TodoStatus` from Task 1; `Routine.todoDriven` from Task 2.
- Produces: `RoutineRunnerDeps` gains:

```ts
  /** Injected by the app for todo-driven routines: core never touches the DB itself. */
  todos?: {
    listPending: (routine: string) => Promise<TodoItem[]>;
    setStatus: (id: string, status: TodoStatus, resultSummary?: string) => Promise<void>;
  };
```

Behavior contract (what Tasks 4/7 rely on): for `routine.todoDriven === true`, `runRoutine` drains pending todos per-todo-whole-pipeline; each executed (todo × step) appends one `StepResult` whose `output` is prefixed with `[todo: <text>] `; a step failure fails that todo (skips its remaining steps) and continues to the next todo; run `status` is `"failed"` if any todo failed; an empty queue (or missing `deps.todos`) yields a successful run with digest `Routine "<name>" finished.\n\nNo pending todos.` and zero steps.

- [ ] **Step 1: Write failing tests**

Read `packages/core/__test__/routine-runner.test.ts` first and reuse its existing fake `deps` helper style. Add:

```ts
describe("todo-driven routines", () => {
  const routine: Routine = {
    name: "nightly", enabled: true, cron: "0 2 * * *", todoDriven: true,
    steps: [
      { kind: "delegate", skill: "plan", instruction: "plan it" },
      { kind: "delegate", skill: "implement", instruction: "build it" },
    ],
    sinks: {},
  };

  function fakeTodos(items: TodoItem[]) {
    const statusLog: { id: string; status: TodoStatus; resultSummary?: string }[] = [];
    return {
      statusLog,
      dep: {
        listPending: async (r: string) => items.filter((t) => t.routine === r && t.status === "pending"),
        setStatus: async (id: string, status: TodoStatus, resultSummary?: string) => {
          statusLog.push({ id, status, resultSummary });
        },
      },
    };
  }

  const todo = (id: string, text: string): TodoItem => ({
    id, routine: "nightly", text, status: "pending", createdAt: "2026-07-15T00:00:00Z", order: Number(id),
  });

  it("runs the whole pipeline per todo, in order, and marks each done", async () => {
    const calls: string[] = [];
    const todos = fakeTodos([todo("1", "task A"), todo("2", "task B")]);
    const result = await runRoutine(routine, {
      chat: async () => ({ content: "digest", toolCalls: [] }),
      model: "m",
      delegate: async (req) => { calls.push(req.instruction); return `ok: ${req.instruction}`; },
      tools: [], findSkill: () => undefined,
      todos: todos.dep,
    });
    // whole-pipeline-per-todo: A/plan, A/implement, B/plan, B/implement
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("plan it");
    expect(calls[0]).toContain("task A");
    expect(calls[1]).toContain("build it");
    expect(calls[1]).toContain("task A");
    expect(calls[2]).toContain("task B"); // B starts only after A's full pipeline
    expect(todos.statusLog).toEqual([
      { id: "1", status: "running", resultSummary: undefined },
      { id: "1", status: "done", resultSummary: expect.stringContaining("ok:") },
      { id: "2", status: "running", resultSummary: undefined },
      { id: "2", status: "done", resultSummary: expect.stringContaining("ok:") },
    ]);
    expect(result.record.status).toBe("ok");
    expect(result.results).toHaveLength(4);
  });

  it("scopes prior outputs to the current todo", async () => {
    const priors: string[] = [];
    const todos = fakeTodos([todo("1", "task A"), todo("2", "task B")]);
    await runRoutine(routine, {
      chat: async () => ({ content: "digest", toolCalls: [] }),
      model: "m",
      delegate: async (req) => { priors.push(req.priorOutputs); return "out"; },
      tools: [], findSkill: () => undefined,
      todos: todos.dep,
    });
    expect(priors[0]).toBe("");           // A step 1: nothing prior
    expect(priors[1]).toContain("out");   // A step 2: sees A step 1
    expect(priors[2]).toBe("");           // B step 1: does NOT see A's outputs
  });

  it("a failing step fails that todo, skips its remaining steps, and continues to the next todo", async () => {
    const calls: string[] = [];
    const todos = fakeTodos([todo("1", "task A"), todo("2", "task B")]);
    const result = await runRoutine(routine, {
      chat: async () => ({ content: "digest", toolCalls: [] }),
      model: "m",
      delegate: async (req) => {
        calls.push(req.instruction);
        if (req.instruction.includes("task A")) throw new Error("boom");
        return "ok";
      },
      tools: [], findSkill: () => undefined,
      todos: todos.dep,
    });
    expect(calls).toHaveLength(3); // A/plan (fails), B/plan, B/implement — A/implement skipped
    expect(todos.statusLog).toEqual([
      { id: "1", status: "running", resultSummary: undefined },
      { id: "1", status: "failed", resultSummary: expect.stringContaining("boom") },
      { id: "2", status: "running", resultSummary: undefined },
      { id: "2", status: "done", resultSummary: "ok" },
    ]);
    expect(result.record.status).toBe("failed");
  });

  it("empty queue is a successful no-op run", async () => {
    const todos = fakeTodos([]);
    const result = await runRoutine(routine, {
      chat: async () => ({ content: "should not be needed", toolCalls: [] }),
      model: "m",
      delegate: async () => { throw new Error("must not run"); },
      tools: [], findSkill: () => undefined,
      todos: todos.dep,
    });
    expect(result.record.status).toBe("ok");
    expect(result.results).toHaveLength(0);
    expect(result.digest).toContain("No pending todos");
  });

  it("non-todo-driven routines are byte-for-byte unaffected by a todos dep", async () => {
    const plain: Routine = { ...routine, todoDriven: undefined };
    const todos = fakeTodos([todo("1", "task A")]);
    const calls: string[] = [];
    await runRoutine(plain, {
      chat: async () => ({ content: "digest", toolCalls: [] }),
      model: "m",
      delegate: async (req) => { calls.push(req.instruction); return "ok"; },
      tools: [], findSkill: () => undefined,
      todos: todos.dep,
    });
    expect(calls).toHaveLength(2); // one per step, no todo loop
    expect(todos.statusLog).toHaveLength(0);
  });
});
```

Add the needed imports at the top of the test file: `import type { TodoItem, TodoStatus } from "../src/index.js";`

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/routine-runner.test.ts`
Expected: FAIL — `todos` isn't a known dep and the todo loop doesn't exist.

- [ ] **Step 3: Implement in `routine-runner.ts`**

Add imports and the dep:

```ts
import type { TodoItem, TodoStatus } from "./todo-store.js";
```

Add to `RoutineRunnerDeps`:

```ts
  /** Injected by the app for todo-driven routines: core never touches the DB itself. */
  todos?: {
    listPending: (routine: string) => Promise<TodoItem[]>;
    setStatus: (id: string, status: TodoStatus, resultSummary?: string) => Promise<void>;
  };
```

Refactor `runRoutine`'s existing step loop into a helper so both paths share it (the todo path injects the todo text and scopes `results`):

```ts
const SUMMARY_CAP = 200;

async function runSteps(
  routine: Routine,
  deps: RoutineRunnerDeps,
  timeoutMs: number,
  results: StepResult[],           // appended in place; also the priorOutputs scope
  instructionSuffix: string,        // "" for plain routines; the todo block for todo runs
  labelPrefix: string,              // "" or `[todo: <text>] `
): Promise<boolean> {              // true = all steps ok
  let allOk = true;
  for (const [index, step] of routine.steps.entries()) {
    const prior = priorOutputsBlock(results);
    const withTask = (s: RoutineStep): RoutineStep =>
      ({ ...s, instruction: s.instruction + instructionSuffix }) as RoutineStep;
    try {
      const effective = withTask(step);
      const output = effective.kind === "delegate"
        ? await deps.delegate({
            skill: deps.findSkill(effective.skill),
            projectPath: effective.project,
            instruction: effective.instruction,
            model: effective.model,
            priorOutputs: prior,
          })
        : await withTimeout(runChatStep(routine, effective, index, prior, deps), timeoutMs, `step ${index + 1}`);
      results.push({ index, kind: step.kind, ok: true, output: labelPrefix + output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ index, kind: step.kind, ok: false, output: labelPrefix + message });
      allOk = false;
      if (instructionSuffix) return false; // todo pipeline: a failed step abandons this todo
    }
  }
  return allOk;
}
```

(Note the asymmetry, preserved deliberately: plain routines keep today's continue-on-failure; a todo's pipeline stops at its first failed step. The `instructionSuffix` truthiness is the discriminator — it's non-empty exactly for todo runs.)

Then rewrite `runRoutine` to branch:

```ts
export async function runRoutine(routine: Routine, deps: RoutineRunnerDeps): Promise<RoutineRunResult> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.stepTimeoutMs ?? ROUTINE_STEP_TIMEOUT_MS;
  const startedAt = now().toISOString();
  const results: StepResult[] = [];
  let allOk = true;

  if (routine.todoDriven && deps.todos) {
    const pending = await deps.todos.listPending(routine.name);
    if (pending.length === 0) {
      // Scheduler already skips empty queues; this is the race backstop (and covers runNow).
      return {
        record: { startedAt, finishedAt: now().toISOString(), status: "ok", digest: `Routine "${routine.name}" finished.\n\nNo pending todos.`, steps: [] },
        digest: `Routine "${routine.name}" finished.\n\nNo pending todos.`,
        results: [],
      };
    }
    for (const item of pending) {
      await deps.todos.setStatus(item.id, "running");
      const scoped: StepResult[] = []; // prior-outputs chain is per-todo, never cross-todo
      const ok = await runSteps(
        routine, deps, timeoutMs, scoped,
        `\n\nQueued task:\n${item.text}`,
        `[todo: ${item.text}] `,
      );
      results.push(...scoped);
      const last = scoped[scoped.length - 1];
      const summary = (last?.output ?? "").slice(0, SUMMARY_CAP);
      await deps.todos.setStatus(item.id, ok ? "done" : "failed", summary);
      if (!ok) allOk = false;
    }
  } else {
    allOk = await runSteps(routine, deps, timeoutMs, results, "", "");
  }

  const digest = await composeDigest(routine, results, deps, timeoutMs);
  const record: RunRecord = {
    startedAt,
    finishedAt: now().toISOString(),
    status: allOk ? "ok" : "failed",
    digest,
    steps: results.map((r) => ({ kind: r.kind, ok: r.ok, summary: r.output.slice(0, SUMMARY_CAP) })),
  };
  return { record, digest, results };
}
```

Also extend `composeDigest`'s system prompt: change the string `"Lead with a one-line overall status, then a short section per step."` to `"Lead with a one-line overall status, then a short section per step. When step outputs are prefixed with [todo: ...], group the sections by todo instead — one briefing per task."`

- [ ] **Step 4: Run tests — new AND existing runner tests must pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/routine-runner.test.ts`
Expected: PASS, including all pre-existing tests (the refactor must not change plain-routine behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routine-runner.ts packages/core/__test__/routine-runner.test.ts
git commit -m "feat(core): per-todo pipeline execution in the routine runner"
```

---

### Task 4: Scheduler — skip todo-driven routines with an empty queue

**Files:**
- Modify: `packages/app/src/routine-scheduler.ts`
- Test: `packages/app/__test__/routine-scheduler.test.ts` (add cases)

**Interfaces:**
- Produces: `RoutineSchedulerDeps` gains `hasPendingTodos?: (routine: string) => Promise<boolean>` (optional; absent = never skip, preserving old behavior in existing tests).
- Skip semantics: at a due fire time for a `todoDriven` routine with no pending todos, advance `lastRun` (so the slot doesn't refire), record **no** run, deliver **no** digest.

- [ ] **Step 1: Write failing tests**

Read `packages/app/__test__/routine-scheduler.test.ts` first and copy its fake-deps/fake-clock pattern. Add:

```ts
it("skips a due todo-driven routine with an empty queue: lastRun advances, no run recorded", async () => {
  // build deps exactly like the existing due-routine test, with:
  //   routine: { ...dueRoutine, todoDriven: true }
  //   hasPendingTodos: async () => false
  // then tick() past the due time and assert:
  //   - runRoutine was NOT called
  //   - deliverDigest was NOT called
  //   - saveStates was called with lastRun advanced for that routine
});

it("runs a due todo-driven routine when the queue has items", async () => {
  // same setup with hasPendingTodos: async () => true — assert runRoutine WAS called
});
```

(Flesh both out concretely against the file's existing helpers — the existing tests already construct a due routine and tick past it; mirror that setup verbatim and only change the two knobs above.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/routine-scheduler.test.ts`
Expected: FAIL — `hasPendingTodos` is not a known dep; the routine runs regardless.

- [ ] **Step 3: Implement**

In `routine-scheduler.ts` add to `RoutineSchedulerDeps`:

```ts
  /** Todo-driven gate: false = skip this fire (advance lastRun, record nothing). Absent = never skip. */
  hasPendingTodos?: (routine: string) => Promise<boolean>;
```

In `tick()`, replace the `if (due.getTime() <= nowT.getTime()) { await execute(routine); }` branch with:

```ts
      if (due.getTime() <= nowT.getTime()) {
        if (routine.todoDriven && deps.hasPendingTodos && !(await deps.hasPendingTodos(routine.name))) {
          // Empty queue: consume the slot without a run — otherwise this stale due time
          // refires every tick forever (same shape as the missed/no-catch-up rule).
          const before = await deps.loadStates();
          const prior = before[routine.name];
          await deps.saveStates({
            ...before,
            [routine.name]: { ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined },
          });
          running.delete(routine.name);
          continue;
        }
        await execute(routine);
      } else {
```

Leave `runNow()` ungated — the runner's own empty-queue no-op (Task 3) covers manual runs, and the panel disables the button anyway (Task 8).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/routine-scheduler.test.ts`
Expected: PASS, existing tests included.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/routine-scheduler.ts packages/app/__test__/routine-scheduler.test.ts
git commit -m "feat(app): scheduler skips todo-driven routines with an empty queue"
```

---

### Task 5: `propose_todo` in `converse()`

**Files:**
- Modify: `packages/core/src/converse.ts`
- Test: `packages/core/__test__/converse.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new from other tasks (pure).
- Produces:
  - `export interface ProposedTodo { routine: string; text: string; }`
  - `ConverseResult` gains `proposedTodo?: ProposedTodo`.
  - `converse()` gains a final optional parameter `todoRoutines: string[] = []` (after `runAvailable`) — the names of todo-driven routines. Empty = the tool is not offered.

- [ ] **Step 1: Write failing tests**

Read `packages/core/__test__/converse.test.ts` first; reuse its fake-chat helper and fixture skills/projects/persona. Add:

```ts
describe("propose_todo", () => {
  it("is not offered when no todo-driven routines exist", async () => {
    let offered: string[] = [];
    await converse([], "queue this", [], [], persona, [], {
      model: "m",
      chat: async ({ tools }) => { offered = tools.map((t) => t.name); return { content: "ok", toolCalls: [] }; },
    });
    expect(offered).not.toContain("propose_todo");
  });

  it("returns proposedTodo on a valid call", async () => {
    const res = await converse([], "queue this", [], [], persona, [], {
      model: "m",
      chat: async () => ({
        content: "queued a draft",
        toolCalls: [{ name: "propose_todo", args: { routine: "nightly", text: "Fix the flaky spec" } }],
      }),
    }, undefined, [], undefined, undefined, false, [], false, true, ["nightly"]);
    expect(res.proposedTodo).toEqual({ routine: "nightly", text: "Fix the flaky spec" });
    expect(res.reply).toBe("queued a draft");
  });

  it("drops the proposal on an unknown routine or empty text", async () => {
    const res = await converse([], "queue this", [], [], persona, [], {
      model: "m",
      chat: async () => ({
        content: "hm",
        toolCalls: [{ name: "propose_todo", args: { routine: "nope", text: "x" } }],
      }),
    }, undefined, [], undefined, undefined, false, [], false, true, ["nightly"]);
    expect(res.proposedTodo).toBeUndefined();
  });
});
```

(Match the positional argument list to the real signature — `converse(history, latestUserText, skills, projects, persona, memories, deps, droppedUrl, actions, now, linkedNote, delegateAvailable, availableClis, rememberAvailable, runAvailable, todoRoutines)`.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: FAIL — no `todoRoutines` param, no `proposedTodo`.

- [ ] **Step 3: Implement**

In `converse.ts`:

1. Export the type and extend the result (next to `ProposedSkill`):

```ts
/** A queue item draft awaiting user confirmation — todos are never queued silently. */
export interface ProposedTodo { routine: string; text: string; }
```

Add `proposedTodo?: ProposedTodo;` to `ConverseResult`.

2. Tool builder (next to `proposeNoteTool`):

```ts
// Enum-constrained to the caller's todo-driven routine names, same trick as propose_run's
// skill/project enums — the model can't invent a queue that doesn't exist.
function proposeTodoTool(todoRoutines: string[]): ToolSpec {
  return {
    name: "propose_todo",
    description:
      "Queue a task on one of the user's todo-driven routines — the routine works through its " +
      "queue on its own schedule (e.g. overnight). Use when the user wants a task queued for " +
      "later rather than done now. The user confirms a card before anything is queued.",
    parameters: {
      type: "object",
      properties: {
        routine: { type: "string", enum: todoRoutines, description: "which routine's queue to add to" },
        text: { type: "string", description: "the task as one self-contained sentence or short paragraph" },
      },
      required: ["routine", "text"],
    },
  };
}
```

3. Signature: add `todoRoutines: string[] = []` as the final parameter (after `runAvailable = true`).

4. Offer the tool — in the `tools` array, after `proposeSkillTool()`:

```ts
    ...(todoRoutines.length > 0 ? [proposeTodoTool(todoRoutines)] : []),
```

5. Handle the call — insert after the `skillCall` block, before `rememberCall`:

```ts
    const todoCall = toolCalls.find((c) => c.name === "propose_todo");
    if (todoCall) {
      const args = (todoCall.args ?? {}) as { routine?: unknown; text?: unknown };
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text || typeof args.routine !== "string" || !todoRoutines.includes(args.routine)) {
        return { reply: content, model: deps.model };
      }
      return { reply: content, model: deps.model, proposedTodo: { routine: args.routine, text } };
    }
```

6. Behavior prompt — append to the string returned by `behaviorInstructions` (unconditionally; the tool's absence keeps it inert when there are no todo-driven routines):

```
 If you are given a propose_todo tool, use it when the user wants a task queued for later instead of done now — the routine runs it on its own schedule; the card is the confirmation.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS, existing tests included (the added trailing param defaults keep old call sites compiling).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): confirm-first propose_todo tool in converse"
```

---

### Task 6: IPC channels, handlers, preload bridge

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Test: `packages/app/__test__/ipc.test.ts` (add a todo-handlers block)

**Interfaces:**
- Consumes: todo-store functions (Task 1) via injected deps.
- Produces:
  - `IPC` entries: `todosList: "bean:todos-list"`, `todosListAll: "bean:todos-list-all"`, `todosAdd: "bean:todos-add"`, `todosEdit: "bean:todos-edit"`, `todosDelete: "bean:todos-delete"`, `todosReorder: "bean:todos-reorder"`, `todosClearFinished: "bean:todos-clear-finished"`, `todosRetry: "bean:todos-retry"`.
  - `buildTodoHandlers(deps: TodoHandlerDeps)` in `ipc.ts` returning `{ list, listAll, add, edit, remove, reorder, clearFinished, retry }`.
  - `window.bean.todosList(routine)`, `todosAdd(routine, text)`, `todosEdit(id, text)`, `todosDelete(id)`, `todosReorder(id, newOrder)`, `todosClearFinished(routine)`, `todosRetry(id)` — all `Promise`-returning invokes. (`listAll` is exposed too, for the future dashboard.)
  - `add` validates the routine exists AND is todo-driven (the store stays dumb, per spec).

- [ ] **Step 1: Write failing handler tests**

Read `packages/app/__test__/ipc.test.ts` first for its builder-test style. Add:

```ts
describe("buildTodoHandlers", () => {
  const routines = [
    { name: "nightly", enabled: true, cron: "0 2 * * *", todoDriven: true, steps: [{ kind: "chat" as const, instruction: "x" }], sinks: {} },
    { name: "plain", enabled: true, cron: "0 8 * * *", steps: [{ kind: "chat" as const, instruction: "x" }], sinks: {} },
  ];
  const makeDeps = () => {
    const added: { routine: string; text: string }[] = [];
    return {
      added,
      deps: {
        dbFile: "/tmp/unused.db",
        loadRoutines: async () => routines,
        addTodo: async (_f: string, routine: string, text: string) => {
          added.push({ routine, text });
          return { id: "1", routine, text, status: "pending" as const, createdAt: "", order: 1 };
        },
        listTodos: async () => [], listAllTodos: async () => [],
        editTodoText: async () => {}, deleteTodo: async () => {}, reorderTodo: async () => {},
        clearFinishedTodos: async () => {}, retryTodo: async () => {},
      },
    };
  };

  it("add inserts into a todo-driven routine's queue", async () => {
    const { deps, added } = makeDeps();
    const h = buildTodoHandlers(deps);
    await h.add("nightly", "do the thing");
    expect(added).toEqual([{ routine: "nightly", text: "do the thing" }]);
  });

  it("add rejects unknown and non-todo-driven routines", async () => {
    const { deps } = makeDeps();
    const h = buildTodoHandlers(deps);
    await expect(h.add("ghost", "x")).rejects.toThrow();
    await expect(h.add("plain", "x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildTodoHandlers` doesn't exist.

- [ ] **Step 3: Implement**

`channels.ts` — add inside the `IPC` object after the `routinesState` group:

```ts
  todosList: "bean:todos-list",
  todosListAll: "bean:todos-list-all",
  todosAdd: "bean:todos-add",
  todosEdit: "bean:todos-edit",
  todosDelete: "bean:todos-delete",
  todosReorder: "bean:todos-reorder",
  todosClearFinished: "bean:todos-clear-finished",
  todosRetry: "bean:todos-retry",
```

`ipc.ts` — add `TodoItem` to the `@bean/core` type imports, then next to `buildRoutineHandlers`:

```ts
export interface TodoHandlerDeps {
  dbFile: string;
  loadRoutines: () => Promise<Routine[]>;
  addTodo: (file: string, routine: string, text: string) => Promise<TodoItem>;
  listTodos: (file: string, routine: string) => Promise<TodoItem[]>;
  listAllTodos: (file: string) => Promise<TodoItem[]>;
  editTodoText: (file: string, id: string, text: string) => Promise<void>;
  deleteTodo: (file: string, id: string) => Promise<void>;
  reorderTodo: (file: string, id: string, newOrder: number) => Promise<void>;
  clearFinishedTodos: (file: string, routine: string) => Promise<void>;
  retryTodo: (file: string, id: string) => Promise<void>;
}

export function buildTodoHandlers(deps: TodoHandlerDeps) {
  return {
    list: (routine: string): Promise<TodoItem[]> => deps.listTodos(deps.dbFile, routine),
    listAll: (): Promise<TodoItem[]> => deps.listAllTodos(deps.dbFile),
    // Routine existence/type is enforced here, not in the store (store stays dumb, per spec).
    add: async (routine: string, text: string): Promise<TodoItem> => {
      const target = (await deps.loadRoutines()).find((r) => r.name === routine);
      if (!target) throw new Error(`no routine named "${routine}"`);
      if (!target.todoDriven) throw new Error(`routine "${routine}" is not todo-driven`);
      return deps.addTodo(deps.dbFile, routine, text);
    },
    edit: (id: string, text: string): Promise<void> => deps.editTodoText(deps.dbFile, id, text),
    remove: (id: string): Promise<void> => deps.deleteTodo(deps.dbFile, id),
    reorder: (id: string, newOrder: number): Promise<void> => deps.reorderTodo(deps.dbFile, id, newOrder),
    clearFinished: (routine: string): Promise<void> => deps.clearFinishedTodos(deps.dbFile, routine),
    retry: (id: string): Promise<void> => deps.retryTodo(deps.dbFile, id),
  };
}
```

Add `todoHandlers: ReturnType<typeof buildTodoHandlers>;` to `RegisterDeps`, and in `registerIpc` after the `routinesRunNow` handle:

```ts
  ipcMain.handle(IPC.todosList, (_e, routine: string) => deps.todoHandlers.list(routine));
  ipcMain.handle(IPC.todosListAll, () => deps.todoHandlers.listAll());
  ipcMain.handle(IPC.todosAdd, (_e, routine: string, text: string) => deps.todoHandlers.add(routine, text));
  ipcMain.handle(IPC.todosEdit, (_e, id: string, text: string) => deps.todoHandlers.edit(id, text));
  ipcMain.handle(IPC.todosDelete, (_e, id: string) => deps.todoHandlers.remove(id));
  ipcMain.handle(IPC.todosReorder, (_e, id: string, newOrder: number) => deps.todoHandlers.reorder(id, newOrder));
  ipcMain.handle(IPC.todosClearFinished, (_e, routine: string) => deps.todoHandlers.clearFinished(routine));
  ipcMain.handle(IPC.todosRetry, (_e, id: string) => deps.todoHandlers.retry(id));
```

`preload.ts` — add `TodoItem` to the `@bean/core` type import list, and inside `exposeInMainWorld` after the `routinesRunNow` entry:

```ts
  todosList: (routine: string): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.todosList, routine),
  todosListAll: (): Promise<TodoItem[]> => ipcRenderer.invoke(IPC.todosListAll),
  todosAdd: (routine: string, text: string): Promise<TodoItem> => ipcRenderer.invoke(IPC.todosAdd, routine, text),
  todosEdit: (id: string, text: string): Promise<void> => ipcRenderer.invoke(IPC.todosEdit, id, text),
  todosDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.todosDelete, id),
  todosReorder: (id: string, newOrder: number): Promise<void> => ipcRenderer.invoke(IPC.todosReorder, id, newOrder),
  todosClearFinished: (routine: string): Promise<void> => ipcRenderer.invoke(IPC.todosClearFinished, routine),
  todosRetry: (id: string): Promise<void> => ipcRenderer.invoke(IPC.todosRetry, id),
```

`renderer/bean.d.ts` — mirror those eight signatures on the `window.bean` interface (type-only import of `TodoItem` from `@bean/core` is fine in a `.d.ts`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): todo queue IPC channels, handlers, and preload bridge"
```

---

### Task 7: `main.ts` wiring + routine rename/delete cascade + chat-handler routine names

**Files:**
- Modify: `packages/app/src/main.ts`
- Modify: `packages/app/src/ipc.ts` (`ChatHandlerDeps`/`buildChatHandler`, `buildRoutineHandlers` cascade)
- Test: `packages/app/__test__/ipc.test.ts` (chat handler passes todo routine names; routine delete cascades)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `ChatHandlerDeps` gains `loadRoutines?: () => Promise<Routine[]>`; `buildChatHandler` passes `todoRoutines` (names of routines with `todoDriven === true`) as `converse`'s final argument.
  - `RoutineHandlerDeps` gains `onRoutineDeleted?: (name: string) => Promise<void>` and `onRoutineRenamed?: (from: string, to: string) => Promise<void>`; `remove` calls the former, `save` calls the latter when saving over a selected different name is not how the panel works (renames don't exist in the panel — names are fixed after creation), so **only wire `onRoutineDeleted`**; skip rename support and note it in the spec's terms: the panel never renames (name input only exists at creation), so `renameTodosRoutine` stays exported-but-unwired until a rename UI exists.
- `recoverInterruptedTodos` called once at startup; runner deps gain `todos`; scheduler deps gain `hasPendingTodos`.

- [ ] **Step 1: Write failing tests**

In `packages/app/__test__/ipc.test.ts`:

```ts
it("buildChatHandler passes todo-driven routine names into converse", async () => {
  // Copy the file's existing buildChatHandler test setup. Add:
  //   loadRoutines: async () => [nightlyTodoDriven, plainRoutine]
  // and a fake converse dep capturing its `tools` — assert the propose_todo tool is offered
  // (i.e. converse was called such that a chat fake receives a tools array containing
  // "propose_todo"). Simplest: fake deps.converse records the tools it was given.
});

it("buildRoutineHandlers.remove cascades to onRoutineDeleted", async () => {
  const deleted: string[] = [];
  const h = buildRoutineHandlers({
    loadRoutines: async () => [],
    saveRoutine: async () => {},
    deleteRoutine: async () => {},
    loadStates: async () => ({}),
    isRunning: () => false,
    runNow: async () => ({ started: true }),
    onRoutineDeleted: async (name) => { deleted.push(name); },
  });
  await h.remove("nightly");
  expect(deleted).toEqual(["nightly"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `ipc.ts`**

`ChatHandlerDeps`: add `loadRoutines?: () => Promise<Routine[]>;`. In `buildChatHandler`, load routines alongside the other catalogs and pass the names:

```ts
    const [skills, projects, persona, memories, routines] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
      deps.loadMemories(deps.dbFile),
      deps.loadRoutines?.() ?? Promise.resolve([] as Routine[]),
    ]);
    const enabled = skills.filter((s) => s.enabled !== false);
    const todoRoutines = routines.filter((r) => r.todoDriven).map((r) => r.name);
    return converse(
      req.history, req.message, enabled, projects, persona, memories,
      { chat: deps.converse, model: deps.getModel() }, req.droppedUrl, deps.actions,
      undefined, req.linkedNote, deps.delegateAvailable?.() ?? false,
      [], false, true, todoRoutines,
    );
```

(The three inserted positional args `[], false, true` are `availableClis`, `rememberAvailable`, `runAvailable` — their existing defaults, now explicit because `todoRoutines` follows them. Double-check against converse's signature.)

`RoutineHandlerDeps`: add `onRoutineDeleted?: (name: string) => Promise<void>;` and in `buildRoutineHandlers`:

```ts
    remove: async (name: string): Promise<void> => {
      await deps.deleteRoutine(name);
      await deps.onRoutineDeleted?.(name);
    },
```

- [ ] **Step 4: Wire `main.ts`**

Add to the `@bean/core` import list in `main.ts`: `listTodos, addTodo, listAllTodos, editTodoText, deleteTodo, reorderTodo, clearFinishedTodos, retryTodo, updateTodoStatus, recoverInterruptedTodos, deleteTodosForRoutine` and types `TodoStatus`.

After the routines block's `routineStatePath` line, add startup recovery:

```ts
    // Anything stuck `running` was interrupted by the previous quit — fail it visibly (retryable).
    const recovered = await recoverInterruptedTodos(dbFile(dir));
    if (recovered > 0) console.warn(`bean: marked ${recovered} interrupted todo(s) as failed`);
```

In `runOneRoutine`, add the `todos` dep to the `runRoutine` call:

```ts
      return runRoutine(routine, {
        chat: runtime.converse,
        model: runtime.getModel(),
        delegate: delegateStep,
        tools: [...actionTools, saveNoteTool],
        findSkill: (name) => skills.find((s) => s.name === name),
        todos: {
          listPending: async (r) => (await listTodos(dbFile(dir), r)).filter((t) => t.status === "pending"),
          setStatus: (id, status: TodoStatus, resultSummary?: string) =>
            updateTodoStatus(dbFile(dir), id, status, resultSummary),
        },
      });
```

In `createRoutineScheduler({...})`, add:

```ts
      hasPendingTodos: async (r) => (await listTodos(dbFile(dir), r)).some((t) => t.status === "pending"),
```

In the `registerIpc` deps object, add (near `routineHandlers`):

```ts
      loadRoutines: () => loadRoutines(routinesPath),
      todoHandlers: buildTodoHandlers({
        dbFile: dbFile(dir),
        loadRoutines: () => loadRoutines(routinesPath),
        addTodo, listTodos, listAllTodos, editTodoText, deleteTodo, reorderTodo,
        clearFinishedTodos, retryTodo,
      }),
```

And extend the existing `routineHandlers: buildRoutineHandlers({ ... })` with:

```ts
        onRoutineDeleted: (name) => deleteTodosForRoutine(dbFile(dir), name),
```

(`buildTodoHandlers` needs importing from `./ipc.js` — it's already exported there.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 (main.ts has no unit tests; typecheck is its gate here).

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/main.ts packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): wire the todo queue into main, runner deps, scheduler, and chat handler"
```

---

### Task 8: Routines panel — type toggle + queue section

**Files:**
- Modify: `packages/app/src/renderer/components/routines/RoutinesPanel.tsx`
- Modify: the routines panel stylesheet (locate it: `grep -rl "bean-routines-step" packages/app/src/renderer` — add the new classes there)

**Interfaces:**
- Consumes: `window.bean.todos*` (Task 6), `Routine.todoDriven` (Task 2), `TodoItem` type (barrel type import is allowed in the renderer).
- Produces: UI only — no new exports.

No unit-test cycle for this task (the repo has no renderer component tests; the e2e suite is advisory). Verification is Step 4's manual run.

- [ ] **Step 1: Type toggle**

In `RoutinesPanel.tsx`, insert a TYPE section between the CADENCE block and the WHAT BEAN DOES block (after the first `bean-routines-divider`):

```tsx
        <div class="bean-skills-projects">
          <div class="bean-routines-section-head">
            <div class="bean-field-label">TYPE</div>
          </div>
          <div class="bean-routines-type-row">
            <button
              type="button"
              class={`bean-btn bean-btn--ghost bean-routines-type-btn${draft.todoDriven ? "" : " bean-routines-type-btn--on"}`}
              onClick={() => setDraft({ ...draft, todoDriven: undefined })}
            >Always runs</button>
            <button
              type="button"
              class={`bean-btn bean-btn--ghost bean-routines-type-btn${draft.todoDriven ? " bean-routines-type-btn--on" : ""}`}
              onClick={() => setDraft({ ...draft, todoDriven: true })}
            >⚡ Todo-driven</button>
            <span class="bean-routines-section-note">
              {draft.todoDriven
                ? "runs the steps below on each queued todo — skips the run when the queue is empty"
                : "runs the steps below on every scheduled fire"}
            </span>
          </div>
        </div>
```

(`todoDriven: undefined` rather than `false` keeps saved JSON clean for the default case.) Also append `· only if the queue has items` to the cadence meta line when `draft.todoDriven` is set, and switch the WHAT BEAN DOES section note to `· run in order on each queued todo · one digest at the end` under the same condition.

- [ ] **Step 2: Queue section**

State + loading (top of the component, next to the other `useState` calls):

```tsx
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodo, setNewTodo] = useState("");

  const refreshTodos = async (): Promise<void> => {
    setTodos(selected && draft.todoDriven ? await window.bean.todosList(selected) : []);
  };
  useEffect(() => { void refreshTodos(); }, [selected, draft.todoDriven]);
  // Piggyback on the existing 5s state poll so "running now" chips update live: inside the
  // existing setInterval effect, also call refreshTodos() when a todo-driven routine is selected.
```

Import the type: `import type { Routine, RoutineStep, Skill, Project, AvailableModel, TodoItem } from "@bean/core";` (type-only barrel import — allowed).

Render, only when `draft.todoDriven && selected` (between TYPE and WHAT BEAN DOES; hidden entirely while creating, since the queue needs a saved routine name to attach to):

```tsx
        {draft.todoDriven && selected ? (
          <div class="bean-skills-projects">
            <div class="bean-routines-section-head">
              <div class="bean-field-label">QUEUE</div>
              <span class="bean-routines-section-note">
                a backlog you fill — each pending item runs through the steps below
              </span>
            </div>
            <div class="bean-routines-queue-meta">
              {todos.filter((t) => t.status === "pending").length} pending · gates this routine
            </div>
            {todos.map((t) => (
              <div key={t.id} class={`bean-routines-todo bean-routines-todo--${t.status}`}>
                <span class="bean-routines-todo-text">{t.text}</span>
                <span class="bean-routines-todo-chip">{t.status === "running" ? "running now" : t.status}</span>
                {t.status === "failed" ? (
                  <button type="button" class="bean-skills-delete-link" title={t.resultSummary}
                    onClick={() => void window.bean.todosRetry(t.id).then(refreshTodos)}>Retry</button>
                ) : null}
                {t.status === "pending" ? (
                  <button type="button" class="bean-skills-delete-link"
                    onClick={() => void window.bean.todosDelete(t.id).then(refreshTodos)}>Remove</button>
                ) : null}
              </div>
            ))}
            <div class="bean-routines-todo-add">
              <input
                class="bean-input bean-input--boxed"
                placeholder="＋ Queue a todo — runs through the steps on the next run"
                value={newTodo}
                onInput={(e) => setNewTodo((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTodo.trim() && selected) {
                    void window.bean.todosAdd(selected, newTodo).then(() => { setNewTodo(""); void refreshTodos(); });
                  }
                }}
              />
            </div>
            {todos.some((t) => t.status === "done" || t.status === "failed") ? (
              <button type="button" class="bean-skills-delete-link"
                onClick={() => { if (selected) void window.bean.todosClearFinished(selected).then(refreshTodos); }}
              >Clear finished</button>
            ) : null}
          </div>
        ) : null}
```

Add matching CSS classes to the routines stylesheet, following its existing tokens: `.bean-routines-type-row` (flex row, gap), `.bean-routines-type-btn--on` (accent border/bg like the mockup's selected segment), `.bean-routines-todo` (row card like `.bean-routines-step-card`, smaller), `.bean-routines-todo--done .bean-routines-todo-text { text-decoration: line-through; opacity: .6; }`, `.bean-routines-todo--running` (accent tint), `.bean-routines-todo-chip` (small pill), `.bean-routines-queue-meta` (caption). Pending items keep queue order; done/failed sort to the bottom naturally if you render `[...todos].sort((a, b) => Number(a.status === "done" || a.status === "failed") - Number(b.status === "done" || b.status === "failed"))` — use that sorted copy in the `.map`.

- [ ] **Step 3: Disable "Run now" on an empty queue**

Replace the Run-now button's `disabled` and label logic:

```tsx
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  const emptyTodoQueue = Boolean(draft.todoDriven) && pendingCount === 0;
  // button: disabled={isRunningSelected || emptyTodoQueue}
  // label: isRunningSelected ? "Running…" : "Run now"
  // and next to it, when emptyTodoQueue: <span class="bean-routines-section-note">queue a todo first</span>
```

Also update the list-row caption: when `r.todoDriven`, render `⚡ todo-driven` after the step count (matches the mockup's sidebar).

- [ ] **Step 4: Verify in the running app**

Run: `pnpm build && pnpm dev`. In the Routines panel: create a routine, save it, flip it to Todo-driven, queue two todos, confirm the pending count/chips render, Run now enables only with pending items, "Clear finished" appears after a run (or after manually flipping — use Run now with a trivial chat step: instruction "reply with the word ok"). Confirm an Always-runs routine looks unchanged. Quit dev with Ctrl+C.

- [ ] **Step 5: Gate and commit**

Run: `pnpm test && pnpm typecheck` — both exit 0.

```bash
git add packages/app/src/renderer/components/routines/ packages/app/src/renderer/  # plus the stylesheet file you edited
git commit -m "feat(app): todo-driven type toggle and queue section in the Routines panel"
```

---

### Task 9: Chat window TodoCard

**Files:**
- Create: `packages/app/src/renderer/components/chat/TodoCard.tsx`
- Modify: `packages/app/src/renderer/components/chat/ChatWindow.tsx`

**Interfaces:**
- Consumes: `ConverseResult.proposedTodo` (Task 5), `window.bean.todosAdd` (Task 6).
- Produces: UI only.

No unit-test cycle (no renderer tests in repo); manual verification in Step 3.

- [ ] **Step 1: Create `TodoCard.tsx`**

Open `NoteCard.tsx` first and mirror its exact prop/State pattern (pending → saved/dismissed states, same class names family). The component shape:

```tsx
import { useState } from "preact/hooks";
import type { ProposedTodo } from "@bean/core";

export function TodoCard(props: { todo: ProposedTodo; state: "pending" | "queued" | "dismissed"; onResolve: (state: "queued" | "dismissed") => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.bean.todosAdd(props.todo.routine, props.todo.text);
      props.onResolve("queued");
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't queue the todo");
    } finally {
      setBusy(false);
    }
  };
  // Render: card shell copied from NoteCard's classes; title line
  // `Queue on "${props.todo.routine}"`, body = props.todo.text, then either the
  // resolved-state caption ("Queued." / "Dismissed.") or Confirm/Dismiss buttons
  // (Confirm disabled while busy), plus the error line when set.
}
```

Fill the render JSX concretely by copying NoteCard's structure — same card classes, same button classes — swapping the note fields for the two todo fields above.

- [ ] **Step 2: Wire into `ChatWindow.tsx`**

Next to the existing lines (`ChatWindow.tsx:225-226`):

```tsx
        if (res.proposedNote) next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending" });
        if (res.proposedSkill) next.push({ kind: "skill", id: newId(), skill: res.proposedSkill, state: "pending" });
```

add:

```tsx
        if (res.proposedTodo) next.push({ kind: "todo", id: newId(), todo: res.proposedTodo, state: "pending" });
```

Extend the transcript-item union type in this file with `{ kind: "todo"; id: string; todo: ProposedTodo; state: "pending" | "queued" | "dismissed" }` (find where the `kind: "note"` variant is declared and add the sibling), import `ProposedTodo` (type-only) and `TodoCard`, and render it where the note/skill cards render, resolving state the same way NoteCard's is resolved (find the `kind === "note"` render branch and add a `kind === "todo"` branch calling `<TodoCard todo={item.todo} state={item.state} onResolve={(s) => updateItemState(item.id, s)} />` — match the file's actual state-update helper name).

- [ ] **Step 3: Verify in the running app**

Run: `pnpm dev`. With a todo-driven routine saved (Task 8), chat: "add 'audit the flaky e2e specs' to my nightly queue". Confirm the card renders, Confirm queues it (check the Routines panel queue), Dismiss leaves no todo. Also confirm chats still work with zero todo-driven routines (tool not offered; no card).

- [ ] **Step 4: Gate and commit**

Run: `pnpm test && pnpm typecheck` — both exit 0.

```bash
git add packages/app/src/renderer/components/chat/
git commit -m "feat(app): confirm-first TodoCard in the chat window"
```

---

### Task 10: Chatops `propose_todo` (Teams + Discord)

**Files:**
- Create: `packages/core/src/chatops/todo-proposals.ts`
- Modify: `packages/core/src/chatops/cards-api.ts`
- Modify: `packages/core/src/chatops/bot.ts`
- Modify: `packages/core/src/index.ts` (export the store if chatops exports flow through the barrel — check how `NoteProposalStore` is exported and mirror it)
- Modify: `packages/teams/src/cards.ts`, `packages/teams/src/server.ts`
- Modify: `packages/discord/src/components.ts`, `packages/discord/src/server.ts`
- Test: `packages/core/__test__/chatops-bot.test.ts` (or wherever bot.ts's note-proposal tests live — find with `grep -rln "noteProposals" packages/core/__test__ packages/teams/__test__ packages/discord/__test__`)

**Interfaces:**
- Consumes: `ProposedTodo` (Task 5).
- Produces:
  - `TodoProposalStore` — byte-for-byte the `NoteProposalStore` pattern (`packages/core/src/chatops/note-proposals.ts`): `PendingTodo { id, todo: ProposedTodo, conversationId, proposedBy, cardActivityId?, createdAt }`, ids `todo-<seq>`, same 10-min expiry, one-shot `claim`.
  - `CardBuilders` gains `todoProposalCard: (input: TodoProposalCardInput) => object` and `todoResultCard: (input: TodoResultCardInput) => object` with
    `interface TodoProposalCardInput { proposalId: string; routine: string; text: string }` and
    `interface TodoResultCardInput { routine: string; queuedBy: string; outcome: "queued" | "cancelled" }`.
  - `TeamsBotDeps` gains `todoProposals: TodoProposalStore;`, `queueTodo: (routine: string, text: string) => Promise<void>;` and `listTodoRoutines: () => Promise<string[]>;`.
  - Card actions `queue-todo` / `cancel-todo` handled in `onCardAction`.

- [ ] **Step 1: Write failing bot tests**

Find the existing note-proposal bot test (`grep -rn "proposedNote" packages/core/__test__`) and clone its structure:

```ts
it("posts a todo proposal card when converse proposes a todo", async () => {
  // fake chat returns { content: "", toolCalls: [{ name: "propose_todo", args: { routine: "nightly", text: "fix it" } }] }
  // deps.listTodoRoutines: async () => ["nightly"]
  // assert fx.postCard was called with the todoProposalCard payload and
  // deps.todoProposals now holds a pending entry
});

it("queue-todo card action queues via deps.queueTodo; cancel-todo does not", async () => {
  // seed todoProposals.add(...), fire onCardAction with beanAction "queue-todo"/"cancel-todo",
  // assert queueTodo called once / never, and updateCard got the result card
});
```

Flesh these out against the actual test file's fake-deps helper (it already builds a full `TeamsBotDeps`; add the three new deps to that helper with inert defaults so existing tests keep compiling).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run` (the chatops bot test file)
Expected: FAIL.

- [ ] **Step 3: Implement core side**

`todo-proposals.ts` — copy `note-proposals.ts` wholesale, renaming: `ProposedNote → ProposedTodo` (import from `../converse.js`), `PendingNote → PendingTodo` (field `note → todo`), `NoteProposalStore → TodoProposalStore`, id prefix `note- → todo-`. Export it wherever `NoteProposalStore` is exported from (check `packages/core/src/index.ts` / chatops barrel).

`cards-api.ts` — next to `NoteProposalCardInput`:

```ts
export interface TodoProposalCardInput { proposalId: string; routine: string; text: string }
export interface TodoResultCardInput { routine: string; queuedBy: string; outcome: "queued" | "cancelled" }
```

and in `CardBuilders`:

```ts
  todoProposalCard: (input: TodoProposalCardInput) => object;
  todoResultCard: (input: TodoResultCardInput) => object;
```

`bot.ts`:

1. Deps (in `TeamsBotDeps`, next to `noteProposals`):

```ts
  todoProposals: TodoProposalStore;
  /** Queues a confirmed todo (server injects the db path + routine validation). */
  queueTodo: (routine: string, text: string) => Promise<void>;
  /** Names of routines with todoDriven=true — gates the propose_todo tool. */
  listTodoRoutines: () => Promise<string[]>;
```

with `import type { TodoProposalStore } from "./todo-proposals.js";`

2. In `onMessage`, load the routine names with the other catalogs (add `deps.listTodoRoutines()` to the `Promise.all`) and pass them as `converse`'s final arg (after `false` for runAvailable) in BOTH `converse` calls (the main one and the `target: chat` follow-up).

3. Handle the proposal — after the `result.proposedSkill` block:

```ts
        if (result.proposedTodo) {
          const todo = result.proposedTodo;
          const pending = deps.todoProposals.add({ todo, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.todoProposalCard({
            proposalId: pending.id, routine: todo.routine, text: todo.text,
          }));
          deps.todoProposals.setCardActivityId(pending.id, activityId);
          return;
        }
```

4. Action handler — clone `handleNoteAction` as `handleTodoAction` (kinds `"queue-todo" | "cancel-todo"`, expiry message "That todo draft expired — ask me to queue it again.", success path `await deps.queueTodo(pending.todo.routine, pending.todo.text)` then result card + `fx.post(\`Queued on "${pending.todo.routine}".\`)`), and dispatch it in `onCardAction` next to the note branch:

```ts
      if (beanAction === "queue-todo" || beanAction === "cancel-todo") {
        await handleTodoAction(beanAction, proposalId, action.fromName, fx);
        return;
      }
```

- [ ] **Step 4: Implement transports**

In `packages/teams/src/cards.ts`: copy `noteProposalCard`/`noteResultCard` bodies into `todoProposalCard`/`todoResultCard`, adjusting: title "Queue a todo on \<routine\>", body = the todo text, buttons "Queue" (`beanAction: "queue-todo"`) / "Cancel" (`beanAction: "cancel-todo"`), result card text "Queued by \<queuedBy\>" / "Cancelled". In `packages/teams/src/server.ts`: import + register them in the `cards` object, construct `todoProposals: new TodoProposalStore()`, and wire `queueTodo`/`listTodoRoutines` the same way `saveNote`/`searchNotes` are wired (the server already injects the db path and loads routines for the runner — reuse those; `queueTodo` = validate routine todoDriven via loaded routines then `addTodo(dbFile, routine, text)`; `listTodoRoutines` = `loadRoutines(...)` filtered to `todoDriven`).

Repeat the same in `packages/discord/src/components.ts` (clone the note component builders) and `packages/discord/src/server.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS across core/teams/discord (their server tests will force you to add the new deps to any fake `TeamsBotDeps` fixtures — do so with inert defaults).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/chatops/ packages/core/src/index.ts packages/teams/src/ packages/discord/src/ packages/core/__test__/
git commit -m "feat(chatops): confirm-first propose_todo cards on Teams and Discord"
```

---

### Task 11: Final validation, memory entry, spec cross-check

**Files:**
- Create: `.memory/project-todo-driven-routines.md`
- Modify: `.memory/INDEX.md`

- [ ] **Step 1: Full gate**

Run: `pnpm test && pnpm typecheck` — both exit 0. Then `pnpm build` — exits 0 (catches renderer node-free-subpath violations that test/typecheck miss, per `.memory/convention-renderer-imports-node-free-subpaths.md`).

- [ ] **Step 2: End-to-end smoke in dev**

`pnpm dev`: create a todo-driven routine with one chat step (instruction: "Reply with one line confirming the queued task."), queue a todo, hit Run now, and verify: queue item goes running → done with a result summary, run history shows the digest grouped by task, and a second Run now with an empty queue is blocked by the disabled button. Also verify a plain routine still runs unchanged.

- [ ] **Step 3: Write the team-memory entry**

`.memory/project-todo-driven-routines.md`:

```markdown
# project-todo-driven-routines

Todo-driven routines: `Routine.todoDriven` turns the step list into a pipeline run once per
queued todo (whole-pipeline-per-todo, prior-outputs scoped per todo; a failed step abandons
that todo but the next still runs — note the asymmetry with plain routines' continue-on-failure).
Queue items are plain text in `bean.db`'s `todos` table (`todo-store.ts`; SQLite not JSON per
safety-memory-append-vs-replace). Scheduler consumes an empty-queue fire by advancing lastRun
WITHOUT recording a run; `runNow` relies on the runner's own empty-queue no-op instead.
`running` items are failed as "interrupted" at startup (`recoverInterruptedTodos` in main.ts) —
retry is always manual. Chat/chatops capture is confirm-first `propose_todo` (enum-gated to
todoDriven routine names); routine runs themselves never get propose_* tools. Deleting a routine
cascades its todos (`onRoutineDeleted`); renames don't exist in the panel, so
`renameTodosRoutine` is exported but unwired. Deferred to v2: user-owned checkbox follow-ups
and Bean-filed follow-ups from run results.
Spec: `docs/superpowers/specs/2026-07-15-todo-driven-routines-design.md`.
```

Add to `.memory/INDEX.md` under "project":

```markdown
- [project-todo-driven-routines](project-todo-driven-routines.md) — per-routine consume-once todo queues: `todos` table, per-todo pipeline in the runner, empty-queue skip semantics, confirm-first `propose_todo`.
```

- [ ] **Step 4: Spec cross-check**

Re-read the spec's sections and confirm each maps to a completed task: Model→1/2, Execution→3, Scheduler→4, Chat capture→5/9/10, UI→8, Wiring→6/7, Validation→2/6, Testing→all. Fix any gap before the final commit.

- [ ] **Step 5: Commit**

```bash
git add .memory/
git commit -m "docs(memory): record todo-driven routines subsystem decisions"
```

---

## Self-Review Notes (already applied)

- Runner failure semantics differ deliberately between plain routines (continue-on-failure) and a todo's pipeline (abort that todo) — encoded in `runSteps`'s `instructionSuffix` discriminator and called out in the memory entry.
- Routine rename cascade from the spec is intentionally dropped: the panel has no rename (name is only editable at creation). `renameTodosRoutine` ships in the store for a future rename UI. This deviation is recorded in the memory entry.
- `converse`'s positional-arg tail is fragile; Tasks 5/7/10 each restate the full order — verify against the real signature when editing.
- Chatops task (10) requires extending existing fake `TeamsBotDeps` fixtures in teams/discord server tests — expected churn, called out in its Step 5.
