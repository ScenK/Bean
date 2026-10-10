import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDelegateTasks, resolveDelegateSelection, resolvedPathSpawnFn, type DelegateEvent } from "../src/delegate-tasks.js";
import { runDelegate, type CliModels, type CliName, type DelegateCallbacks, type DelegateHandle, type DelegateRequest } from "@bean/core";

const CLI_MODELS: CliModels[] = [
  { provider: "claude", models: ["sonnet"] },
  { provider: "codex", models: ["gpt-5.6-sol"] },
];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bean-delegate-tasks-"));
}

function harness(opts: { cli?: CliName; dir?: string } = {}) {
  const sent: DelegateEvent[] = [];
  const cancels: string[] = [];
  const cancelCallbacks: (() => void)[] = [];
  const captured: DelegateCallbacks[] = [];
  const reqs: DelegateRequest[] = [];
  let nextId = 0;
  const tasks = createDelegateTasks({
    resolveCli: () => ({ cli: opts.cli ?? "claude" }),
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

describe("resolveDelegateSelection", () => {
  it("Auto follows enabled CLI order instead of configured model order", () => {
    expect(resolveDelegateSelection(CLI_MODELS, ["codex", "claude"], "")).toEqual({
      cli: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("an untouched request honors an enabled configured Codex preference", () => {
    expect(resolveDelegateSelection(CLI_MODELS, ["claude", "codex"], "codex")).toEqual({
      cli: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("an explicitly selected model may override the configured CLI with a compatible provider", () => {
    expect(resolveDelegateSelection(CLI_MODELS, ["codex", "claude"], "codex", "sonnet")).toEqual({
      cli: "claude",
      model: "sonnet",
    });
  });
});

describe("createDelegateTasks", () => {
  it("uses one resolved compatible CLI/model pair for a delegate request", async () => {
    const reqs: DelegateRequest[] = [];
    const tasks = createDelegateTasks({
      resolveCli: () => ({ cli: "codex", model: "gpt-5.6-sol" }),
      send: () => {},
      newId: () => "task-pair",
      dir: tmp(),
      run: (req) => {
        reqs.push(req);
        return { cancel: () => {} } satisfies DelegateHandle;
      },
    });

    await tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it", model: "sonnet" });

    expect(reqs).toEqual([{
      cli: "codex",
      projectPath: "/p",
      prompt: "go",
      model: "gpt-5.6-sol",
    }]);
  });

  it("browser comes only from main's re-resolved skill, never a forged or absent name", async () => {
    const reqs: DelegateRequest[] = [];
    const tasks = createDelegateTasks({
      resolveCli: () => ({ cli: "claude" }),
      send: () => {},
      newId: (() => { let n = 0; return () => `t-${++n}`; })(),
      dir: tmp(),
      skillBrowser: async (name) => name === "web-post",
      run: (req) => { reqs.push(req); return { cancel: () => {} } satisfies DelegateHandle; },
    });
    await tasks.start({ projectPath: "/a", prompt: "go", instruction: "i", skillName: "web-post" });
    await tasks.start({ projectPath: "/b", prompt: "go", instruction: "i", skillName: "../forged" });
    await tasks.start({ projectPath: "/c", prompt: "go", instruction: "i" });
    expect(reqs.map((r) => r.browser)).toEqual([true, undefined, undefined]);
  });

  it("start resolves the CLI, spawns via run, and emits started", async () => {
    const h = harness({ cli: "opencode" });
    const id = await h.tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    expect(id).toBe("task-1");
    expect(h.req()).toEqual({ cli: "opencode", projectPath: "/p", prompt: "go" });
    expect(h.sent).toEqual([{ taskId: "task-1", type: "started", projectPath: "/p", instruction: "do it" }]);
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
    expect(sent).toEqual([{ taskId: "task-x", type: "failed", message: "No enabled delegate CLI found — enable one in Settings." }]);
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
    expect(h.sent.at(-1)).toMatchObject({ taskId: id, type: "started" });
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
    expect(h.sent).toContainEqual({ taskId: idC, type: "started", projectPath: "/p", instruction: "again" });
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

describe("timeout racing Stop (real runDelegate)", () => {
  it("a Stop between the timeout SIGTERM and close still settles the task as failed and releases it", async () => {
    vi.useFakeTimers();
    try {
      const dir = tmp();
      const sent: DelegateEvent[] = [];
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      const tasks = createDelegateTasks({
        resolveCli: () => ({ cli: "claude" }),
        send: (e) => { sent.push(e); },
        newId: () => "task-1",
        dir,
        run: (req, cbs) => runDelegate(req, cbs, () => child as unknown as ChildProcess, 60_000),
      });
      const id = await tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
      vi.advanceTimersByTime(60_000); // timeout fires: SIGTERM sent, child not yet closed
      tasks.cancel(id);
      child.emit("close", 143);
      expect(sent.at(-1)).toMatchObject({ taskId: id, type: "failed", message: expect.stringContaining("timed out") });
      expect(readdirSync(join(dir, "runs"))).toEqual([]);
      tasks.cancel(id); // task is gone — no-op
      expect(sent.filter((e) => e.type === "failed" || e.type === "cancelled")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delegate session receipts", () => {
  it("a session id reported synchronously during spawn still reaches the failed event; the run is recorded", async () => {
    const dir = tmp();
    const sent: DelegateEvent[] = [];
    let captured: DelegateCallbacks | undefined;
    const tasks = createDelegateTasks({
      resolveCli: () => ({ cli: "claude" }),
      send: (e) => { sent.push(e); },
      newId: () => "t1",
      dir,
      run: (_req, cbs) => {
        cbs.onSessionStart?.(1, "sess-1");
        captured = cbs;
        return { cancel: () => {} };
      },
    });
    await tasks.start({ projectPath: "/it's/p", prompt: "composed", instruction: "fix it" });
    captured!.onError(new Error("boom"));
    expect(sent.at(-1)).toEqual({
      taskId: "t1", type: "failed", message: "boom",
      receipt: { label: "claude · sess…", command: "cd '/it'\\''s/p' && claude --resume sess-1" },
    });
    const db = new DatabaseSync(join(dir, "bean.db"));
    const rows = db.prepare("SELECT surface, instruction FROM delegate_runs").all();
    db.close();
    expect(rows.map((r) => ({ ...r }))).toEqual([{ surface: "desktop", instruction: "fix it" }]);
  });

  it("a cancelled run carries the receipt; a run with no valid session id has none", async () => {
    const h = harness();
    await h.tasks.start({ projectPath: "/p", prompt: "go", instruction: "go" });
    h.cbs().onSessionStart?.(1, "sess-2");
    h.tasks.cancel("task-1");
    h.cancelCallbacks[0]!();
    expect(h.sent.at(-1)).toMatchObject({ type: "cancelled", receipt: { command: "cd '/p' && claude --resume sess-2" } });
    await h.tasks.start({ projectPath: "/q", prompt: "go", instruction: "go" });
    h.cbs().onSessionStart?.(2, "--help");
    h.cbs().onDone("ok");
    expect(h.sent.at(-1)).toEqual({ taskId: "task-2", type: "done", result: "ok" });
  });
});


// opencode takes its working dir from an inherited PWD over the spawn cwd (#247).
it("the resolved-PATH spawn sets PWD to the spawn cwd", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bean-pwd-")));
  const child = resolvedPathSpawnFn("/usr/bin:/bin")!(process.execPath, ["-e", "process.stdout.write(process.env.PWD ?? '')"], cwd);
  let out = "";
  child.stdout?.on("data", (d) => { out += String(d); });
  await new Promise((resolve) => child.on("close", resolve));
  expect(out).toBe(cwd);
});
