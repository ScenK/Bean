import { describe, expect, it } from "vitest";
import { createDelegateTasks, type DelegateEvent } from "../src/delegate-tasks.js";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "@bean/core";

function harness(opts: { cli?: "claude" | "opencode" } = {}) {
  const sent: DelegateEvent[] = [];
  const cancels: string[] = [];
  const captured: DelegateCallbacks[] = [];
  const reqs: DelegateRequest[] = [];
  let nextId = 0;
  const tasks = createDelegateTasks({
    resolveCli: () => opts.cli ?? "claude",
    send: (e) => { sent.push(e); },
    newId: () => `task-${++nextId}`,
    run: (req, cbs) => {
      reqs.push(req);
      captured.push(cbs);
      return { cancel: () => cancels.push(req.prompt) } satisfies DelegateHandle;
    },
  });
  return { tasks, sent, cancels, captured, reqs, cbs: () => captured.at(-1)!, req: () => reqs.at(-1)! };
}

describe("createDelegateTasks", () => {
  it("start resolves the CLI, spawns via run, and emits started", () => {
    const h = harness({ cli: "opencode" });
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    expect(id).toBe("task-1");
    expect(h.req()).toEqual({ cli: "opencode", projectPath: "/p", prompt: "go" });
    expect(h.sent).toEqual([{ taskId: "task-1", type: "started" }]);
  });

  it("emits a deferred failed event when no CLI is available", async () => {
    const h = harness();
    const tasks = createDelegateTasks({
      resolveCli: () => undefined,
      send: (e) => { h.sent.push(e); },
      newId: () => "task-x",
      run: () => { throw new Error("must not spawn"); },
    });
    tasks.start({ projectPath: "/p", prompt: "go" });
    expect(h.sent).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.sent).toEqual([{ taskId: "task-x", type: "failed", message: "No delegate CLI found — install claude or opencode." }]);
  });

  it("forwards output, done, and failed callbacks as events", () => {
    const h = harness();
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    h.cbs().onOutput("▸ Edit");
    h.cbs().onDone("all done");
    expect(h.sent.slice(1)).toEqual([
      { taskId: id, type: "output", line: "▸ Edit" },
      { taskId: id, type: "done", result: "all done" },
    ]);
  });

  it("cancel kills the handle and emits cancelled; later callbacks are ignored", () => {
    const h = harness();
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    h.tasks.cancel(id);
    expect(h.cancels).toEqual(["go"]);
    expect(h.sent.at(-1)).toEqual({ taskId: id, type: "cancelled" });
    h.cbs().onDone("too late");
    h.cbs().onOutput("too late");
    expect(h.sent.filter((e) => e.type === "done" || e.type === "output")).toEqual([]);
  });

  it("cancel of an unknown or finished task is a no-op", () => {
    const h = harness();
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    h.cbs().onDone("done");
    const before = h.sent.length;
    h.tasks.cancel(id);
    h.tasks.cancel("nope");
    expect(h.sent.length).toBe(before);
  });

  it("cancelAll cancels every running task and emits cancelled for each", () => {
    const h = harness();
    const a = h.tasks.start({ projectPath: "/p", prompt: "one" });
    const b = h.tasks.start({ projectPath: "/p", prompt: "two" });
    h.tasks.cancelAll();
    expect(h.cancels).toEqual(["one", "two"]);
    expect(h.sent.filter((e) => e.type === "cancelled").map((e) => e.taskId)).toEqual([a, b]);
  });

  it("cancelAll skips already-finished tasks and is idempotent", () => {
    const h = harness();
    h.tasks.start({ projectPath: "/p", prompt: "one" });
    h.cbs().onDone("done");
    h.tasks.cancelAll();
    h.tasks.cancelAll();
    expect(h.cancels).toEqual([]);
    expect(h.sent.filter((e) => e.type === "cancelled")).toEqual([]);
  });
});
