import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDelegateTasks, type DelegateEvent } from "../src/delegate-tasks.js";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "@bean/core";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bean-delegate-tasks-"));
}

function harness(opts: { cli?: "claude" | "opencode"; dir?: string } = {}) {
  const sent: DelegateEvent[] = [];
  const cancels: string[] = [];
  const cancelCallbacks: (() => void)[] = [];
  const captured: DelegateCallbacks[] = [];
  const reqs: DelegateRequest[] = [];
  let nextId = 0;
  const tasks = createDelegateTasks({
    resolveCli: () => opts.cli ?? "claude",
    send: (e) => { sent.push(e); },
    newId: () => `task-${++nextId}`,
    dir: opts.dir ?? tmp(),
    run: (req, cbs) => {
      reqs.push(req);
      captured.push(cbs);
      return { cancel: (onCancelled) => { cancels.push(req.prompt); cancelCallbacks.push(onCancelled); } } satisfies DelegateHandle;
    },
  });
  return { tasks, sent, cancels, cancelCallbacks, captured, reqs, cbs: () => captured.at(-1)!, req: () => reqs.at(-1)! };
}

describe("createDelegateTasks", () => {
  it("start resolves the CLI, spawns via run, and emits started", async () => {
    const h = harness({ cli: "opencode" });
    const id = await h.tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    expect(id).toBe("task-1");
    expect(h.req()).toEqual({ cli: "opencode", projectPath: "/p", prompt: "go" });
    expect(h.sent).toEqual([{ taskId: "task-1", type: "started" }]);
  });

  it("emits a deferred failed event when no CLI is available", async () => {
    const sent: DelegateEvent[] = [];
    const tasks = createDelegateTasks({
      resolveCli: () => undefined,
      send: (e) => { sent.push(e); },
      newId: () => "task-x",
      dir: tmp(),
      run: () => { throw new Error("must not spawn"); },
    });
    await tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    expect(sent).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([{ taskId: "task-x", type: "failed", message: "No delegate CLI found — install claude or opencode." }]);
  });

  it("forwards output, done, and failed callbacks as events", async () => {
    const h = harness();
    const id = await h.tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    h.cbs().onOutput("▸ Edit");
    h.cbs().onDone("all done");
    expect(h.sent.slice(1)).toEqual([
      { taskId: id, type: "output", line: "▸ Edit" },
      { taskId: id, type: "done", result: "all done" },
    ]);
  });

  it("cancel emits cancelled only after the handle confirms termination; later callbacks are ignored", async () => {
    const h = harness();
    const id = await h.tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    h.tasks.cancel(id);
    expect(h.cancels).toEqual(["go"]);
    expect(h.sent.at(-1)).toEqual({ taskId: id, type: "started" });
    h.cancelCallbacks[0]!();
    expect(h.sent.at(-1)).toEqual({ taskId: id, type: "cancelled" });
    h.cbs().onDone("too late");
    h.cbs().onOutput("too late");
    expect(h.sent.filter((e) => e.type === "done" || e.type === "output")).toEqual([]);
  });

  it("cancel of an unknown or finished task is a no-op", async () => {
    const h = harness();
    const id = await h.tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    h.cbs().onDone("done");
    const before = h.sent.length;
    h.tasks.cancel(id);
    h.tasks.cancel("nope");
    expect(h.sent.length).toBe(before);
  });

  it("a second start on the same project path is rejected while the first runs", async () => {
    const h = harness();
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it" });
    const idB = await h.tasks.start({ projectPath: "/p", prompt: "two", instruction: "do it again" });
    expect(h.reqs).toHaveLength(1); // second start never spawned
    await new Promise((resolve) => setImmediate(resolve)); // the rejection is a deferred send, like the no-CLI case
    expect(h.sent).toContainEqual({ taskId: idB, type: "failed", message: "A run is already going in that project — wait for it or cancel it first." });
    h.cbs().onDone("done");
    // freed after completion
    const idC = await h.tasks.start({ projectPath: "/p", prompt: "three", instruction: "again" });
    expect(h.sent).toContainEqual({ taskId: idC, type: "started" });
  });

  it("cancelAll cancels every running task and emits cancelled for each", async () => {
    const h = harness();
    const a = await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it" });
    const b = await h.tasks.start({ projectPath: "/q", prompt: "two", instruction: "do it too" });
    h.tasks.cancelAll();
    expect(h.cancels).toEqual(["one", "two"]);
    expect(h.sent.filter((e) => e.type === "cancelled")).toEqual([]);
    h.cancelCallbacks.forEach((cb) => cb());
    expect(h.sent.filter((e) => e.type === "cancelled").map((e) => e.taskId)).toEqual([a, b]);
  });

  it("cancelAll skips already-finished tasks and is idempotent", async () => {
    const h = harness();
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it" });
    h.cbs().onDone("done");
    h.tasks.cancelAll();
    h.tasks.cancelAll();
    expect(h.cancels).toEqual([]);
    expect(h.sent.filter((e) => e.type === "cancelled")).toEqual([]);
  });

  it("interruptAll leaves reservations in place, leaves a chat outbox notice per task, and clears in-memory state", async () => {
    const dir = tmp();
    const h = harness({ dir });
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "fix the bug" });
    await h.tasks.start({ projectPath: "/q", prompt: "two", instruction: "add the feature" });
    h.tasks.interruptAll();
    expect(h.cancels).toEqual(["one", "two"]);
    // The reservations are NOT released: this process is exiting with no confirmation the
    // delegate children actually stopped, so releasing blind would let a relaunch double-run
    // the same project. They stay busy (under each reservation's already-live pid) until reclaimed.
    expect(readdirSync(join(dir, "runs"))).toHaveLength(2);
    const outboxFiles = readdirSync(join(dir, "outbox"));
    expect(outboxFiles).toHaveLength(2);
    expect(outboxFiles.every((f) => f.startsWith("chat-"))).toBe(true);
    // A relaunch (simulated by a second harness sharing the same dir) still sees both as busy.
    const h2 = harness({ dir });
    const idAgain = await h2.tasks.start({ projectPath: "/p", prompt: "again", instruction: "retry" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h2.sent).toContainEqual({ taskId: idAgain, type: "failed", message: "A run is already going in that project — wait for it or cancel it first." });
  });

  it("cancel does not release the reservation until the handle confirms the child actually stopped", async () => {
    const dir = tmp();
    const h = harness({ dir });
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it" });
    h.tasks.cancel("task-1");
    // SIGTERM sent (via h.cancels), but the confirmation callback hasn't fired yet — the
    // project must still read as busy.
    expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
    expect(h.sent.filter((e) => e.type === "cancelled")).toEqual([]);
    h.cancelCallbacks[0]!();
    expect(h.sent.filter((e) => e.type === "cancelled")).toHaveLength(1);
    expect(readdirSync(join(dir, "runs"))).toEqual([]); // released only now
  });
});
