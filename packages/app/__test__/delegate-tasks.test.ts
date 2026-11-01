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
    projectAllowed: async () => true,
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
  it("runs a no-project (\"\") request in the scratch workspace, a real path", async () => {
    const reqs: DelegateRequest[] = [];
    const sent: DelegateEvent[] = [];
    const tasks = createDelegateTasks({
      projectAllowed: async () => true,
      resolveCli: () => ({ cli: "claude" }),
      send: (e) => { sent.push(e); },
      newId: () => "task-scratch",
      dir: tmp(),
      scratchPath: "/home/.bean/workspace",
      run: (req) => { reqs.push(req); return { cancel: () => {} } satisfies DelegateHandle; },
    });
    await tasks.start({ projectPath: "", prompt: "go", instruction: "do it" });
    await tasks.start({ projectPath: "/p", prompt: "go", instruction: "do it" });
    expect(reqs.map((r) => r.projectPath)).toEqual(["/home/.bean/workspace", "/p"]);
    expect(sent[0]).toMatchObject({ type: "started", projectPath: "/home/.bean/workspace" });
  });

  it("spawns only in a registered project or the scratch workspace; anything else fails with zero spawns", async () => {
    const reqs: DelegateRequest[] = [];
    const sent: DelegateEvent[] = [];
    const registered = new Set(["/home/.bean/workspace", "/registered"]);
    const tasks = createDelegateTasks({
      projectAllowed: async (path) => registered.has(path),
      resolveCli: () => ({ cli: "claude" }),
      send: (e) => { sent.push(e); },
      newId: (() => { let n = 0; return () => `t-${++n}`; })(),
      dir: tmp(),
      scratchPath: "/home/.bean/workspace",
      run: (req) => { reqs.push(req); return { cancel: () => {} } satisfies DelegateHandle; },
    });
    await tasks.start({ projectPath: "/registered", prompt: "go", instruction: "i" });
    await tasks.start({ projectPath: "", prompt: "go", instruction: "i" });
    await tasks.start({ projectPath: "/etc", prompt: "go", instruction: "i", mountId: "m1" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(reqs.map((r) => r.projectPath)).toEqual(["/registered", "/home/.bean/workspace"]);
    expect(sent.at(-1)).toEqual({ taskId: "t-3", type: "failed", message: "That project isn't configured in Bean.", mountId: "m1" });
  });

  it("a registry read that throws refuses the run", async () => {
    const sent: DelegateEvent[] = [];
    const tasks = createDelegateTasks({
      projectAllowed: async () => { throw new Error("bad json"); },
      resolveCli: () => ({ cli: "claude" }),
      send: (e) => { sent.push(e); },
      newId: () => "t",
      dir: tmp(),
      run: () => { throw new Error("must not spawn"); },
    });
    await tasks.start({ projectPath: "/p", prompt: "go", instruction: "i" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([{ taskId: "t", type: "failed", message: "That project isn't configured in Bean." }]);
  });

  it("uses one resolved compatible CLI/model pair for a delegate request", async () => {
    const reqs: DelegateRequest[] = [];
    const tasks = createDelegateTasks({
      projectAllowed: async () => true,
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
      projectAllowed: async () => true,
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
      projectAllowed: async () => true,
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

  it("two starts on one project run at once, each recorded and settled on its own", async () => {
    const dir = tmp();
    const h = harness({ dir });
    const idA = await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it" });
    const idB = await h.tasks.start({ projectPath: "/p", prompt: "two", instruction: "do it again" });
    expect(h.reqs.map((r) => r.prompt)).toEqual(["one", "two"]);
    expect(h.sent).toContainEqual({ taskId: idB, type: "started", projectPath: "/p", instruction: "do it again" });
    expect(readdirSync(join(dir, "runs")).sort()).toEqual([`${idA}.json`, `${idB}.json`]);
    h.captured[0]!.onDone("first");
    expect(h.sent).toContainEqual({ taskId: idA, type: "done", result: "first" });
    expect(readdirSync(join(dir, "runs"))).toEqual([`${idB}.json`]);
    // Another process sharing ~/.bean (a bot, or a relaunch) isn't refused either.
    const h2 = harness({ dir });
    await h2.tasks.start({ projectPath: "/p", prompt: "three", instruction: "again" });
    expect(h2.reqs).toHaveLength(1);
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

  it("cancelMount cancels only that chat's tasks", async () => {
    const h = harness();
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it", mountId: "a" });
    await h.tasks.start({ projectPath: "/q", prompt: "two", instruction: "do it too", mountId: "b" });
    await h.tasks.start({ projectPath: "/r", prompt: "three", instruction: "no chat" });
    h.tasks.cancelMount("a");
    h.tasks.cancelMount("a");
    expect(h.cancels).toEqual(["one"]);
  });

  it("tags every event with the chat that started it, so a hidden chat still gets its result", async () => {
    const h = harness();
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it", mountId: "a" });
    h.cbs().onOutput("working");
    h.cbs().onDone("done");
    await h.tasks.start({ projectPath: "/r", prompt: "three", instruction: "no chat" });
    expect(h.sent.map((e) => [e.type, e.mountId])).toEqual([["started", "a"], ["output", "a"], ["done", "a"], ["started", undefined]]);
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

  it("interruptAll leaves run records in place, leaves a chat outbox notice per task, and clears in-memory state", async () => {
    const dir = tmp();
    const h = harness({ dir });
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "fix the bug" });
    await h.tasks.start({ projectPath: "/q", prompt: "two", instruction: "add the feature" });
    h.tasks.interruptAll();
    expect(h.cancels).toEqual(["one", "two"]);
    // The records are NOT released: this process is exiting with no confirmation the delegate
    // children actually stopped, so boot cleanup must still find them.
    expect(readdirSync(join(dir, "runs"))).toHaveLength(2);
    const outboxFiles = readdirSync(join(dir, "outbox"));
    expect(outboxFiles).toHaveLength(2);
    expect(outboxFiles.every((f) => f.startsWith("chat-"))).toBe(true);
  });

  it("cancel does not release the run record until the handle confirms the child actually stopped", async () => {
    const dir = tmp();
    const h = harness({ dir });
    await h.tasks.start({ projectPath: "/p", prompt: "one", instruction: "do it" });
    h.tasks.cancel("task-1");
    // SIGTERM sent (via h.cancels), but the confirmation callback hasn't fired yet — crash
    // cleanup must still see the run.
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
        projectAllowed: async () => true,
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
      projectAllowed: async () => true,
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
      receipt: { label: "claude · sess…", command: "cd '/it'\\''s/p' && claude --resume sess-1", sessionId: "sess-1", agent: "claude" },
    });
    const db = new DatabaseSync(join(dir, "bean.db"));
    const rows = db.prepare("SELECT surface, instruction FROM delegate_runs").all();
    db.close();
    expect(rows.map((r) => ({ ...r }))).toEqual([{ surface: "desktop", instruction: "fix it" }]);
  });

  it("an off-the-record run records its session with no instruction text (#506)", async () => {
    const dir = tmp();
    const h = harness({ dir });
    await h.tasks.start({ projectPath: "/p", prompt: "composed secret", instruction: "secret plan", offRecord: true });
    h.cbs().onSessionStart?.(1, "sess-3");
    h.cbs().onDone("ok");
    expect(h.sent.at(-1)).toMatchObject({ type: "done", receipt: { sessionId: "sess-3" } });
    const db = new DatabaseSync(join(dir, "bean.db"));
    const rows = db.prepare("SELECT session_id, instruction FROM delegate_runs").all();
    db.close();
    expect(rows.map((r) => ({ ...r }))).toEqual([{ session_id: "sess-3", instruction: "" }]);
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
