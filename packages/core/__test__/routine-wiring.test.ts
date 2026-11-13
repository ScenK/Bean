// packages/core/__test__/routine-wiring.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFile } from "../src/config.js";
import { createRoutineWiring, type RoutineWiringDeps } from "../src/routine-wiring.js";
import { addTodo, claimTodo, listTodos } from "../src/todo-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-wiring-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const wiring = (canSchedule: () => boolean) => createRoutineWiring({
  dir, builtinDir: dir, converse: async () => ({ content: "", toolCalls: [] }), getModel: () => "m",
  clis: () => [], cliModels: [], getDelegateCli: () => "", path: "", tools: [],
  getRoutineDigestContext: () => false, canSchedule, alarm: () => {},
} satisfies RoutineWiringDeps);

describe("createRoutineWiring start", () => {
  it("fails the previous holder's running todos, then starts only while the lease is held", async () => {
    await addTodo(dbFile(dir), "r", "stuck");
    await claimTodo(dbFile(dir), "r");
    const interval = vi.spyOn(globalThis, "setInterval");

    await wiring(() => false).start();
    expect((await listTodos(dbFile(dir), "r"))[0]?.status).toBe("failed");
    expect(interval).not.toHaveBeenCalled();

    const w = wiring(() => true);
    await w.start();
    expect(interval).toHaveBeenCalledTimes(1);
    w.scheduler.stop();
  });
});
