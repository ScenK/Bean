import { chmodSync, lstatSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DelegateCallbacks, DelegateHandle, Memory, Note, Project, Routine, Skill } from "@bean/core";
import { createDelegateTasks } from "../src/delegate-tasks.js";
import { applyDelegateEvent, createMcpRuns, MAX_FINISHED_RUNS } from "../src/mcp-runs.js";
import { clientLabel, createMcpHandlers, startMcpListener, type McpHandlerDeps, MAX_FRAME_BYTES } from "../src/mcp-server.js";
import { createBridge, lineSplitter, type BridgeConnection } from "../src/mcp-bridge.js";
import { MCP_TOOLS, NOT_RUNNING, mcpSnippets } from "../src/mcp-tools.js";

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bean-mcp-"));
  chmodSync(d, 0o700);
  return d;
};
const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
const json = (r: CallToolResult): any => JSON.parse(text(r));

const PROJECTS: Project[] = [{ name: "api", path: "/work/api" }, { name: "web", path: "/work/web" }];

/** The real createDelegateTasks with a fake spawn, wired to the registry the way main.ts does. */
function harness(over: Partial<McpHandlerDeps> = {}) {
  const runs = createMcpRuns();
  const spawned: { cbs: DelegateCallbacks; cancelled: (() => void) | undefined; prompt: string }[] = [];
  const bubbles: { id: string; kind: string; name: string; line: string }[] = [];
  let id = 0;
  const delegates = createDelegateTasks({
    dir: tmp(),
    resolveCli: () => ({ cli: "claude" }),
    newId: () => `00000000-0000-0000-0000-00000000000${++id}`,
    send: (e) => {
      const fed = applyDelegateEvent(runs, e, (p) => p.split("/").at(-1) ?? p);
      if (fed && e.type === "cancelled") bubbles.push({ id: e.taskId, kind: "delegate", name: "", line: fed.stopped });
    },
    run: (req, cbs) => {
      const s = { cbs, cancelled: undefined as (() => void) | undefined, prompt: req.prompt };
      spawned.push(s);
      return { cancel: (onCancelled) => { s.cancelled = onCancelled; } } satisfies DelegateHandle;
    },
  });
  const memories: Memory[] = [
    { id: "m1", text: "prefers pnpm", createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "m2", text: "uses zed", createdAt: "2026-10-02T00:00:00.000Z" },
  ];
  const deleted: string[][] = [];
  const todos: [string, string][] = [];
  const routines: Routine[] = [
    { name: "inbox", enabled: true, cron: "0 9 * * *", todoDriven: true, steps: [{ kind: "chat", instruction: "x" }], sinks: {} } as Routine,
    { name: "report", enabled: true, cron: "0 9 * * *", steps: [{ kind: "chat", instruction: "x" }], sinks: {} } as Routine,
  ];
  const skills: Skill[] = [
    { name: "review", description: "", body: "Review it." },
    { name: "off", description: "", body: "", enabled: false },
    { name: "talk", description: "", body: "", target: "chat" },
  ];
  let routineFinish: ((o: { status: "done" | "failed"; digest: string }) => void) | undefined;
  const deps: McpHandlerDeps = {
    searchNotes: async () => [],
    saveNote: async (d) => d.slug ?? "new-note",
    loadNotes: async () => [{ slug: "new-note", version: 1 } as Note],
    loadMemories: async () => memories,
    deleteMemories: async (ids) => { deleted.push(ids); return ids.length; },
    rememberIntoBatch: async (add) => { memories.push(...add); return add.length; },
    loadProjects: async () => PROJECTS,
    loadSkills: async () => skills,
    loadRoutines: async () => routines,
    loadRoutineStates: async () => ({}),
    isRoutineRunning: () => false,
    startRoutine: async (name, onFinish) => {
      if (name !== "report") return { started: false, reason: `no routine named "${name}"` };
      routineFinish = onFinish;
      return { started: true };
    },
    addTodo: async (r, t) => { todos.push([r, t]); },
    models: () => ["sonnet"],
    scratchPath: "/home/.bean/workspace",
    delegates,
    runs,
    bubble: (bid, kind, name, line) => { bubbles.push({ id: bid, kind, name, line }); },
    memoryBubble: (n) => { bubbles.push({ id: "memory:batch", kind: "memory", name: "Memory", line: String(n) }); },
    cancelWaitMs: 50,
    ...over,
  };
  const h = createMcpHandlers(deps);
  const ctx = (client = "Claude Code") => ({ client, known: new Set<string>() });
  return { h, runs, spawned, bubbles, deleted, todos, memories, ctx, delegates, finishRoutine: (o: { status: "done" | "failed"; digest: string }) => routineFinish?.(o) };
}

describe("MCP run registry", () => {
  it("keeps every running run and caps finished history", () => {
    const runs = createMcpRuns();
    runs.add({ id: "live", kind: "delegate", client: "a", instruction: "x", project: "p", startedAt: "2026-10-05T00:00:00.000Z" });
    for (let i = 0; i < MAX_FINISHED_RUNS + 5; i++) {
      runs.add({ id: `f${i}`, kind: "delegate", client: "a", instruction: "x", project: "p", startedAt: `2026-10-05T01:00:${String(i).padStart(2, "0")}.000Z` });
      runs.finish(`f${i}`, "done");
    }
    const list = runs.list();
    expect(list).toHaveLength(MAX_FINISHED_RUNS + 1);
    expect(list[0]!.id).toBe("live");
    expect(runs.get("f0")).toBeUndefined();
    expect(list[1]!.id).toBe(`f${MAX_FINISHED_RUNS + 4}`); // newest first after running
  });

  it("labels by: agent only when the confirmed outcome is a requested cancel", () => {
    const runs = createMcpRuns();
    const add = (id: string) => runs.add({ id, kind: "delegate", client: "a", instruction: "x", project: "p", startedAt: "2026-10-05T00:00:00.000Z" });
    add("won"); add("raced");
    expect(runs.requestCancel("won", "Codex")).toBe(true);
    expect(runs.finish("won", "cancelled")).toMatchObject({ state: "cancelled", by: "agent", cancelledBy: "Codex" });
    runs.finish("raced", "done", { result: "ok" }); // finished before anyone asked
    expect(runs.requestCancel("raced", "Codex")).toBe(false);
    expect(runs.get("raced")).toMatchObject({ state: "done" });
    expect(runs.get("raced")!.by).toBeUndefined();
  });
});

describe("MCP tool handlers", () => {
  it("forget_memory only reaches ids this connection recalled", async () => {
    const { h, deleted, ctx } = harness();
    const c = ctx();
    expect((await h.call("forget_memory", { ids: ["m1"] }, c)).isError).toBe(true);
    const recalled = json(await h.call("recall_memories", {}, c));
    expect(recalled.map((m: Memory) => m.id)).toEqual(["m2", "m1"]); // newest first
    expect(json(await h.call("forget_memory", { ids: ["m1", "nope"] }, c))).toEqual({ forgotten: 1 });
    expect(deleted).toEqual([["m1"]]);
    expect((await h.call("forget_memory", { ids: ["m1"] }, ctx())).isError).toBe(true); // another connection
  });

  it("remember rejects instruction- and secret-shaped facts and skips duplicates", async () => {
    const { h, ctx, bubbles } = harness();
    expect(text(await h.call("remember", { text: "Always reply in French" }, ctx()))).toMatch(/instructions/);
    expect(text(await h.call("remember", { text: "token sk-abcdefghijklmnop1234" }, ctx()))).toMatch(/secret/);
    expect(json(await h.call("remember", { text: "Prefers pnpm" }, ctx()))).toMatchObject({ remembered: false });
    expect(json(await h.call("remember", { text: "Likes tea", project: "api" }, ctx()))).toMatchObject({ remembered: true });
    expect(bubbles.filter((b) => b.id === "memory:batch")).toHaveLength(1);
    expect((await h.call("remember", { text: "Likes tea", project: "nope" }, ctx())).isError).toBe(true);
  });

  it("validates arguments before any IO and coalesces write bubbles per client", async () => {
    const { h, ctx, bubbles, todos } = harness();
    expect((await h.call("save_note", { title: "t", body: "b", slug: "../x" }, ctx())).isError).toBe(true);
    expect((await h.call("save_note", { title: 5, body: "b" }, ctx())).isError).toBe(true);
    expect((await h.call("save_note", "nope", ctx())).isError).toBe(true);
    expect(text(await h.call("save_note", { title: "t", slug: "keep-me" }, ctx()))).toMatch(/body is required/);
    expect((await h.call("drop_tables", {}, ctx())).isError).toBe(true);
    expect((await h.call("add_todo", { routine: "report", text: "x" }, ctx())).isError).toBe(true); // not todo-driven
    await h.call("add_todo", { routine: "inbox", text: "a" }, ctx());
    await h.call("add_todo", { routine: "inbox", text: "b" }, ctx());
    expect(todos).toEqual([["inbox", "a"], ["inbox", "b"]]);
    expect(bubbles.at(-1)).toMatchObject({ id: "mcp:Claude Code:todo", line: "Added 2 todos · via Claude Code" });
    expect(json(await h.call("save_note", { title: "t", body: "b" }, ctx()))).toEqual({ slug: "new-note", version: 1 });
  });

  it("start_delegate accepts only registered projects and enabled terminal skills/models", async () => {
    const { h, ctx, spawned } = harness();
    expect(text(await h.call("start_delegate", { instruction: "go", project: "/etc" }, ctx()))).toMatch(/Registered projects: api, web/);
    expect(text(await h.call("start_delegate", { instruction: "go", skill: "off" }, ctx()))).toMatch(/Enabled skills: review/);
    expect(text(await h.call("start_delegate", { instruction: "go", skill: "talk" }, ctx()))).toMatch(/Unknown or disabled/);
    expect(text(await h.call("start_delegate", { instruction: "go", model: "gpt-x" }, ctx()))).toMatch(/Configured models: sonnet/);
    const started = json(await h.call("start_delegate", { instruction: "go", project: "api", skill: "review" }, ctx()));
    expect(started).toMatchObject({ state: "running", project: "api" });
    expect(spawned[0]!.prompt).toContain("Review it.");
    // Same project again: refused by the manager's guard, reported as an error.
    expect(text(await h.call("start_delegate", { instruction: "again", project: "api" }, ctx()))).toMatch(/already going/);
  });

  it("caps running delegates, counting starts still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // The real manager, but every start parks (like an awaited skillBrowser) until released.
    const slow: ReturnType<typeof harness> = harness({
      delegates: { start: async (req) => { await gate; return slow.delegates.start(req); }, cancel: (id) => slow.delegates.cancel(id) },
    });
    const calls = Array.from({ length: 6 }, (_, i) => slow.h.call("start_delegate", { instruction: `job ${i}`, project: i % 2 ? "api" : "web" }, slow.ctx()));
    await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => /already running/.test(text(r)) && /Bean delegates/.test(text(r)))).toHaveLength(2);
  });

  it("client A starts, client B lists and cancels; a duplicate cancel stays cancelling", async () => {
    const { h, ctx, spawned, bubbles } = harness();
    const { taskId } = json(await h.call("start_delegate", { instruction: "long job", project: "web" }, ctx("Claude Code")));
    const listed = json(await h.call("list_delegates", {}, ctx("Codex")));
    expect(listed).toMatchObject([{ id: taskId, client: "Claude Code", state: "running", project: "web", instruction: "long job" }]);
    const first = json(await h.call("cancel_delegate", { taskId }, ctx("Codex")));
    expect(first.state).toBe("cancelling"); // child hasn't confirmed within the wait
    expect(json(await h.call("cancel_delegate", { taskId }, ctx("Codex"))).state).toBe("cancelling");
    spawned[0]!.cancelled!(); // the child's close
    const done = json(await h.call("delegate_status", { id: taskId, wait_seconds: 0 }, ctx("Claude Code")));
    expect(done).toMatchObject({ state: "cancelled", by: "agent", cancelledBy: "Codex" });
    expect(bubbles.at(-1)!.line).toBe("Cancelled by Codex");
    // Cancelling a finished run returns its state, not an error.
    expect(json(await h.call("cancel_delegate", { taskId }, ctx()))).toMatchObject({ state: "cancelled" });
  });

  it("cancel_delegate never reaches runs outside the MCP registry", async () => {
    const { h, ctx, spawned } = harness();
    // A delegate on some other instance (chat window / bots) with its own id.
    const chat = createDelegateTasks({
      dir: tmp(), resolveCli: () => ({ cli: "claude" }), newId: () => "11111111-1111-1111-1111-111111111111", send: () => {},
      run: (_r, _c) => ({ cancel: () => { throw new Error("must not be signalled"); } }),
    });
    const chatId = await chat.start({ projectPath: "/work/api", prompt: "p", instruction: "i" });
    for (const id of [chatId, "routine:nightly", "not-a-uuid", "../../x"]) {
      expect((await h.call("cancel_delegate", { taskId: id }, ctx())).isError).toBe(true);
    }
    expect(spawned).toHaveLength(0);
  });

  it("delegate_status long-polls until the run finishes and returns the result", async () => {
    const { h, ctx, spawned } = harness();
    const { taskId } = json(await h.call("start_delegate", { instruction: "go" }, ctx()));
    spawned[0]!.cbs.onOutput("working…");
    const status = h.call("delegate_status", { id: taskId, wait_seconds: 5 }, ctx());
    setTimeout(() => spawned[0]!.cbs.onDone("all done"), 10);
    expect(json(await status)).toMatchObject({ state: "done", result: "all done", project: "workspace" });
    expect(text(await h.call("delegate_status", { id: "nope" }, ctx()))).toMatch(/Unknown id/);
  });

  it("run_routine returns at once and the run's outcome lands in delegate_status", async () => {
    const { h, ctx, finishRoutine } = harness();
    expect(json(await h.call("run_routine", { name: "ghost" }, ctx()))).toMatchObject({ started: false });
    const { started, runId } = json(await h.call("run_routine", { name: "report" }, ctx()));
    expect(started).toBe(true);
    expect(json(await h.call("delegate_status", { id: runId, wait_seconds: 0 }, ctx())).state).toBe("running");
    finishRoutine({ status: "done", digest: "3 items" });
    expect(json(await h.call("delegate_status", { id: runId, wait_seconds: 0 }, ctx()))).toMatchObject({ state: "done", result: "3 items" });
    expect((await h.call("cancel_delegate", { taskId: runId }, ctx())).isError).toBe(true); // routines aren't cancellable
  });

  it("clientInfo.name is cleaned display text", () => {
    expect(clientLabel("Claude\u0007 Code\n")).toBe("Claude Code");
    expect(clientLabel("x".repeat(80))).toHaveLength(40);
    expect(clientLabel(undefined)).toBe("an AI app");
  });

  it("closing the chat instance's delegates leaves MCP delegates running", async () => {
    const { h, ctx, spawned, runs } = harness();
    const chat = createDelegateTasks({ dir: tmp(), resolveCli: () => ({ cli: "claude" }), newId: () => "c", send: () => {}, run: () => ({ cancel: () => {} }) });
    const { taskId } = json(await h.call("start_delegate", { instruction: "go", project: "api" }, ctx()));
    chat.cancelAll(); // what closing the chat window does
    expect(spawned[0]!.cancelled).toBeUndefined();
    expect(runs.get(taskId)!.state).toBe("running");
  });
});

describe("MCP shim bridge", () => {
  function bridgeHarness() {
    const out: any[] = [];
    let backend: { lines: any[]; onLine: (l: string) => void; onClose: () => void } | undefined;
    let up = false;
    const bridge = createBridge({
      version: "1.0.0", latestProtocol: "2025-11-25", supportedProtocols: ["2025-11-25", "2025-06-18"],
      out: (l) => out.push(JSON.parse(l)),
      connect: async (onLine, onClose) => {
        if (!up) return undefined;
        const lines: any[] = [];
        backend = { lines, onLine, onClose };
        return { write: (l) => { lines.push(JSON.parse(l)); }, close: () => {} } satisfies BridgeConnection;
      },
    });
    const send = (m: object) => bridge.input(JSON.stringify({ jsonrpc: "2.0", ...m }));
    return { out, send, start: () => { up = true; }, stop: () => { up = false; backend?.onClose(); }, backend: () => backend! };
  }

  it("answers initialize/tools/list itself and fails calls while Bean is closed", async () => {
    const b = bridgeHarness();
    await b.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await b.send({ method: "notifications/initialized" });
    await b.send({ id: 2, method: "tools/list" });
    await b.send({ id: 3, method: "tools/call", params: { name: "list_routines", arguments: {} } });
    expect(b.out[0].result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "bean" } });
    expect(b.out[1].result.tools.map((t: { name: string }) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(b.out[2].result).toEqual({ content: [{ type: "text", text: NOT_RUNNING }], isError: true });
  });

  it("replays initialize when Bean appears mid-session and swallows the replay's reply", async () => {
    const b = bridgeHarness();
    await b.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await b.send({ method: "notifications/initialized" });
    b.start();
    await b.send({ id: 2, method: "tools/call", params: { name: "list_routines" } });
    const sent = b.backend().lines;
    expect(sent.map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(sent[0].id).not.toBe(1);
    b.backend().onLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: {} }));
    b.backend().onLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
    expect(b.out.map((m) => m.id)).toEqual([1, 2]); // replay reply swallowed
  });

  it("fails an in-flight call when Bean goes away and never replays it", async () => {
    const b = bridgeHarness();
    b.start();
    await b.send({ id: 1, method: "initialize", params: {} });
    b.backend().onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    await b.send({ id: 7, method: "tools/call", params: { name: "save_note" } });
    b.stop();
    expect(b.out.at(-1)).toMatchObject({ id: 7, error: { message: expect.stringMatching(/may or may not have run/) } });
    await b.send({ id: 8, method: "tools/call", params: { name: "list_routines" } });
    expect(b.out.at(-1)).toMatchObject({ id: 8, result: { isError: true } }); // offline now; 7 not resent
  });

  it("splits partial frames and multi-byte characters across chunks", () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('{"a":"é"}\r\n{"b":1}\n{"c"');
    feed(bytes.subarray(0, 7)); // splits é's two bytes
    feed(bytes.subarray(7));
    expect(lines).toEqual(['{"a":"é"}', '{"b":1}']);
  });
});

describe("MCP socket listener", () => {
  const handlers = { call: async () => ({ content: [{ type: "text" as const, text: "ok" }] }) };

  it("serves MCP over a 0600 socket end to end, through the shim bridge", async () => {
    const dir = tmp();
    const listener = await startMcpListener({ dir, version: "9.9.9", handlers });
    try {
      expect(lstatSync(listener.path).mode & 0o777).toBe(0o600);
      const out: any[] = [];
      const bridge = createBridge({
        version: "x", latestProtocol: "2025-11-25", supportedProtocols: ["2025-11-25"],
        out: (l) => out.push(JSON.parse(l)),
        connect: (onLine, onClose) => new Promise((resolve) => {
          const s = connect(listener.path);
          s.on("data", lineSplitter(onLine));
          s.once("connect", () => resolve({ write: (l) => { s.write(`${l}\n`); }, close: () => s.end() }));
          s.once("close", onClose);
        }),
      });
      await bridge.input(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }));
      await bridge.input(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      await bridge.input(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_routines", arguments: {} } }));
      await expect.poll(() => out.length).toBe(2);
      expect(out[0].result.serverInfo).toMatchObject({ name: "bean", version: "9.9.9" });
      expect(out[1].result.content[0].text).toBe("ok");
      bridge.close();
    } finally {
      listener.stop();
    }
  });

  it("drops a connection that sends an oversize frame", async () => {
    const dir = tmp();
    const listener = await startMcpListener({ dir, version: "1", handlers });
    try {
      const s = connect(listener.path);
      const closed = new Promise<void>((r) => s.once("close", () => r()));
      s.on("error", () => {});
      s.write("x".repeat(MAX_FRAME_BYTES + 10));
      await closed;
    } finally {
      listener.stop();
    }
  });

  it("cleans up a stale socket but never unlinks a live one, a symlink or a plain file", async () => {
    const dir = tmp();
    const path = join(dir, "mcp.sock");
    // Live: someone is answering on it.
    const live = createServer(() => {});
    await new Promise<void>((r) => live.listen(path, r));
    await expect(startMcpListener({ dir, version: "1", handlers })).rejects.toThrow(/already serving/);
    expect(existsSync(path)).toBe(true);
    await new Promise<void>((r) => live.close(() => r()));
    // Stale: a SIGKILLed server leaves its socket file behind with nobody answering.
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`]);
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    child.kill("SIGKILL");
    await new Promise<void>((r) => child.once("exit", () => r()));
    expect(lstatSync(path).isSocket()).toBe(true);
    const ok = await startMcpListener({ dir, version: "1", handlers });
    ok.stop();

    const dir2 = tmp();
    writeFileSync(join(dir2, "elsewhere"), "");
    symlinkSync(join(dir2, "elsewhere"), join(dir2, "mcp.sock"));
    await expect(startMcpListener({ dir: dir2, version: "1", handlers })).rejects.toThrow(/isn't a socket/);
    const dir3 = tmp();
    writeFileSync(join(dir3, "mcp.sock"), "keep me");
    await expect(startMcpListener({ dir: dir3, version: "1", handlers })).rejects.toThrow(/isn't a socket/);
  });

  it("refuses a group/world-writable directory", async () => {
    const dir = tmp();
    chmodSync(dir, 0o777);
    await expect(startMcpListener({ dir, version: "1", handlers })).rejects.toThrow(/writable by other users/);
  });
});

describe("Connect AI apps snippets", () => {
  it("quote paths with spaces and quotes for the shell, and carry the run-as-node env", () => {
    const [cc, codex, oc, desktop] = mcpSnippets("/Applications/My Bean.app/Contents/MacOS/Bean", "/x/it's/mcp-shim.cjs");
    expect(cc!.text).toBe(`claude mcp add -s user bean --env ELECTRON_RUN_AS_NODE=1 -- '/Applications/My Bean.app/Contents/MacOS/Bean' '/x/it'\\''s/mcp-shim.cjs'`);
    expect(codex!.text).toContain("codex mcp add bean --env ELECTRON_RUN_AS_NODE=1 -- ");
    expect(JSON.parse(oc!.text).mcp.bean).toEqual({ type: "local", command: ["/Applications/My Bean.app/Contents/MacOS/Bean", "/x/it's/mcp-shim.cjs"], environment: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(JSON.parse(desktop!.text).mcpServers.bean.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
