// packages/core/__test__/routine-wiring.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFile } from "../src/config.js";
import { createRoutineWiring, type RoutineWiringDeps } from "../src/routine-wiring.js";
import { addTodo, claimTodo, listTodos } from "../src/todo-store.js";
import { getDispatch, openDispatch, type Dispatch } from "../src/dispatch-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-wiring-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const wiring = (canSchedule: () => boolean, deliverDispatch?: RoutineWiringDeps["deliverDispatch"]) => createRoutineWiring({
  dir, builtinDir: dir, converse: async () => ({ content: "", toolCalls: [] }), getModel: () => "m",
  clis: () => [], cliModels: [], getDelegateCli: () => "", path: "", tools: [],
  canSchedule, alarm: () => {},
  ...(deliverDispatch ? { deliverDispatch } : {}),
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

  it("closes the previous holder's open dispatches as interrupted and delivers each once", async () => {
    const id = openDispatch(dbFile(dir), { surface: "teams", conversation: "c1", routine: "r" });
    const sent: Dispatch[] = [];
    const deliver = async (d: Dispatch) => { sent.push(d); return true; };
    // A standby never sweeps: the holder's start owns half-done hand-offs.
    await wiring(() => false, deliver).deliverDispatches();
    const w = wiring(() => true, deliver);
    await w.start();
    await w.start();
    w.scheduler.stop();
    expect(sent.map((d) => [d.id, d.status])).toEqual([[id, "interrupted"]]);
    expect(getDispatch(dbFile(dir), id)?.deliveredAt).toBeDefined();
  });
});
