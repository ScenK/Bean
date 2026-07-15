import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTodo, listTodos, listAllTodos, updateTodoStatus, editTodoText, reorderTodo,
  deleteTodo, clearFinishedTodos, retryTodo, recoverInterruptedTodos,
  renameTodosRoutine, deleteTodosForRoutine,
} from "../src/index.js";
import { closeDb } from "../src/db.js";

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
