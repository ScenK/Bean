import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionRegistry, type LiveSessionSink } from "../src/chatops/live-sessions.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest } from "../src/live-session.js";

// Fresh temp dir per call — reserveRun's file lock is per-`dir`, so this keeps each test's
// project-path reservation isolated from every other test (matches chatops-runs.test.ts).
function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bean-live-sessions-"));
}

function fakeStart() {
  const sent: string[] = [];
  let cbs!: LiveSessionCallbacks;
  let stopped = false;
  const startFn = (req: LiveSessionRequest, callbacks: LiveSessionCallbacks): LiveSessionHandle => {
    cbs = callbacks;
    sent.push(req.prompt);
    return {
      pid: 1,
      send: (t) => sent.push(t),
      stop: () => { stopped = true; queueMicrotask(() => cbs.onExit(undefined)); },
    };
  };
  return { startFn, sent, cbs: () => cbs, wasStopped: () => stopped };
}

function fakeSink() {
  const posts: string[] = [];
  const edits: [string, string][] = [];
  const sink: LiveSessionSink = {
    post: async (text) => { posts.push(text); return `msg-${posts.length}`; },
    edit: async (id, text) => { edits.push([id, text]); },
  };
  return { sink, posts, edits };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flushTicks = async (reg: { /* just to satisfy lint */ } | unknown, ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("LiveSessionRegistry", () => {
  it("start binds the channel; a second start on the same channel is refused", () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { dir: tmp() });
    const { sink } = fakeSink();
    expect(reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink })).toBe(true);
    expect(reg.has("c")).toBe(true);
    expect(reg.start({ channelId: "c", projectPath: "/p", instruction: "again", sink })).toBe(false);
  });

  it("start refuses a second channel targeting the same project (cross-process reservation)", () => {
    const dir = tmp();
    // pid: process.pid (this test process — always live and self-signalable), not fakeStart's
    // hardcoded pid 1 (a reserved system pid `isLive()`'s liveness probe can't signal).
    const aliveStart = (): LiveSessionHandle => ({ pid: process.pid, send: () => {}, stop: () => {} });
    const regA = new LiveSessionRegistry(aliveStart as never, { dir });
    const regB = new LiveSessionRegistry(aliveStart as never, { dir });
    const { sink } = fakeSink();
    expect(regA.start({ channelId: "a", projectPath: "/p", instruction: "go", sink })).toBe(true);
    // Different channel, different registry instance, same project — refused.
    expect(regB.start({ channelId: "b", projectPath: "/p", instruction: "go", sink })).toBe(false);
    expect(regB.has("b")).toBe(false);
    // A different project on the same registry sharing the same dir is unaffected.
    expect(regB.start({ channelId: "b", projectPath: "/other", instruction: "go", sink })).toBe(true);
  });

  it("releases the project reservation once the session ends, allowing a new one on it", async () => {
    const dir = tmp();
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { dir });
    const { sink } = fakeSink();
    reg.start({ channelId: "a", projectPath: "/p", instruction: "go", sink });
    f.cbs().onExit(undefined);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const f2 = fakeStart();
    const reg2 = new LiveSessionRegistry(f2.startFn as never, { dir });
    expect(reg2.start({ channelId: "b", projectPath: "/p", instruction: "go", sink })).toBe(true);
  });

  it("posts buffered output on the throttle tick, then edits the same message", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink });
    f.cbs().onOutput("line one");
    await flushTicks(reg, 1001);
    expect(s.posts).toEqual(["line one"]);
    f.cbs().onOutput("line two");
    await flushTicks(reg, 1001);
    expect(s.edits).toEqual([["msg-1", "line one\nline two"]]);
  });

  it("rolls over to a new message when the buffer exceeds the limit", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink });
    f.cbs().onOutput("a".repeat(1500));
    await flushTicks(reg, 1001);
    f.cbs().onOutput("b".repeat(1500));
    await flushTicks(reg, 1001);
    // first message finalized at <=1900 chars, remainder became a new post
    expect(s.posts.length + s.edits.length).toBeGreaterThanOrEqual(2);
    const rendered = [...s.posts, ...s.edits.map(([, t]) => t)];
    expect(Math.max(...rendered.map((t) => t.length))).toBeLessThanOrEqual(1900);
  });

  it("turn completion appends a footer, reports the result, and the next turn starts a fresh message", async () => {
    const f = fakeStart();
    const results: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onTurnResult: (r) => results.push(r) });
    f.cbs().onOutput("working");
    f.cbs().onTurnComplete({ result: "all done", durationMs: 2000, costUsd: 0.01 });
    await flushTicks(reg, 1001);
    expect(results).toEqual(["all done"]);
    expect(s.posts[0]).toContain("working");
    expect(s.posts[0]).toContain("turn done");
    f.cbs().onOutput("next turn output");
    await flushTicks(reg, 1001);
    expect(s.posts[1]).toBe("next turn output"); // fresh message, not an edit
  });

  it("send forwards to the handle; stop tears down and fires onEnded once", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onEnded: (n) => notices.push(n) });
    reg.send("c", "a hint");
    expect(f.sent).toContain("a hint");
    expect(reg.stop("c")).toBe(true);
    await flushTicks(reg, 1);
    expect(f.wasStopped()).toBe(true);
    expect(reg.has("c")).toBe(false);
    expect(notices).toHaveLength(1);
    expect(reg.stop("c")).toBe(false);
  });

  it("a crash exit produces an error notice", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onEnded: (n) => notices.push(n) });
    f.cbs().onExit(new Error("claude exited with code 1"));
    await flushTicks(reg, 1);
    expect(reg.has("c")).toBe(false);
    expect(notices[0]).toContain("code 1");
  });

  it("retries a rolled-over chunk without losing it when the sink rejects once (bug 1 regression)", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const posts: string[] = [];
    let postCallCount = 0;
    const sink: LiveSessionSink = {
      post: async (text) => {
        postCallCount++;
        if (postCallCount === 1) throw new Error("rate limited");
        posts.push(text);
        return `msg-${posts.length}`;
      },
      edit: async () => {},
    };
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink });
    // Buffer exceeds MSG_LIMIT (1900), forcing a rollover split at the newline.
    const original = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
    f.cbs().onOutput(original);
    await flushTicks(reg, 1001); // first attempt: post() rejects — head must survive for retry
    await flushTicks(reg, 1001); // second attempt: post() succeeds, rollover completes
    // Nothing lost: the posted chunks rejoin into the exact original content.
    expect(posts.join("\n")).toBe(original);
    expect(postCallCount).toBeGreaterThan(1); // confirms a retry actually happened
  });

  it("teardown waits for an in-flight flush before firing onEnded (bug 2 regression)", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const posts: string[] = [];
    const edits: string[] = [];
    let postCallCount = 0;
    let resolveFirstPost!: () => void;
    const sink: LiveSessionSink = {
      post: async (text) => {
        postCallCount++;
        if (postCallCount === 1) {
          // A controllable deferred: this call stays pending until we resolve it below,
          // simulating a real network post that's in flight when the process exits.
          await new Promise<void>((resolve) => { resolveFirstPost = resolve; });
        }
        posts.push(text);
        return `msg-${posts.length}`;
      },
      edit: async (_id, text) => { edits.push(text); },
    };
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink, onEnded: (n) => notices.push(n) });

    f.cbs().onOutput("first chunk");
    // Throttle tick fires: flushSession calls sink.post("first chunk"), which now hangs.
    await flushTicks(reg, 1001);
    expect(postCallCount).toBe(1);

    // More output arrives while that post is still in flight.
    f.cbs().onOutput("second chunk arrived mid-flush");

    // The process exits right now — onExit is driven independently of the throttle timer.
    f.cbs().onExit(undefined);

    // The in-flight flush hasn't resolved yet, so onEnded must not have fired.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(notices).toHaveLength(0);

    // Let the in-flight sink.post resolve; teardown should then force a final flush of the
    // content that arrived mid-flush before firing onEnded.
    resolveFirstPost();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(notices).toHaveLength(1);
    expect([...posts, ...edits].join("\n")).toContain("second chunk arrived mid-flush");
  });

  it("preserves output that arrives while a turn-closing send is in flight (bug 3 regression)", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const posts: string[] = [];
    let postCallCount = 0;
    let resolveFirstPost!: () => void;
    const sink: LiveSessionSink = {
      post: async (text) => {
        postCallCount++;
        if (postCallCount === 1) {
          await new Promise<void>((resolve) => { resolveFirstPost = resolve; });
        }
        posts.push(text);
        return `msg-${posts.length}`;
      },
      edit: async () => {},
    };
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink });

    f.cbs().onOutput("turn one output");
    f.cbs().onTurnComplete({ result: "done", durationMs: 100 }); // sets closeAfterFlush = true

    // Throttle tick dispatches the turn-closing send, which hangs.
    await flushTicks(reg, 1001);
    expect(postCallCount).toBe(1);

    // The next turn's first output arrives while that closing send is still in flight.
    f.cbs().onOutput("turn two output");

    resolveFirstPost();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The turn-one send must contain exactly turn one's content, uncorrupted by the append.
    expect(posts[0]).toContain("turn one output");
    expect(posts[0]).not.toContain("turn two output");

    // Turn two's output must not be silently dropped by the turn-close reset — the next
    // tick delivers it as a fresh message (closeAfterFlush already reset msgId).
    await flushTicks(reg, 1001);
    expect(posts[1]).toBe("turn two output");
  });

  it("forceKillAll SIGKILLs every active session's process group immediately", () => {
    let nextPid = 100;
    const startFn = (): LiveSessionHandle => ({ pid: nextPid++, send: () => {}, stop: () => {} });
    const reg = new LiveSessionRegistry(startFn as never, { dir: tmp() });
    const { sink } = fakeSink();
    reg.start({ channelId: "a", projectPath: "/p", instruction: "go", sink });
    reg.start({ channelId: "b", projectPath: "/p", instruction: "go", sink });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    reg.forceKillAll();

    expect(killSpy).toHaveBeenCalledWith(-100, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(-101, "SIGKILL");
    expect(killSpy).toHaveBeenCalledTimes(2);
    killSpy.mockRestore();
  });

  it("forceKillAll tolerates a kill on an already-dead process", () => {
    const startFn = (): LiveSessionHandle => ({ pid: 42, send: () => {}, stop: () => {} });
    const reg = new LiveSessionRegistry(startFn as never, { dir: tmp() });
    const { sink } = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });

    expect(() => reg.forceKillAll()).not.toThrow();
    killSpy.mockRestore();
  });

  it("retries the final teardown flush on transient failure, delivering the content once it succeeds", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const posts: string[] = [];
    let attempt = 0;
    const sink: LiveSessionSink = {
      post: async (text) => {
        attempt++;
        if (attempt < 3) throw new Error("rate limited");
        posts.push(text);
        return `msg-${posts.length}`;
      },
      edit: async () => {},
    };
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink, onEnded: (n) => notices.push(n) });

    f.cbs().onOutput("final words");
    f.cbs().onExit(undefined); // no timer left afterward to retry a failed send on its own

    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(notices).toHaveLength(0); // first attempt failed — still retrying, not given up

    await vi.advanceTimersByTimeAsync(501); // between attempt 1 and 2 (also fails)
    await vi.advanceTimersByTimeAsync(501); // between attempt 2 and 3 (succeeds)

    expect(posts).toEqual(["final words"]);
    expect(notices).toEqual(["Live session ended."]);
  });

  it("gives up after bounded retries and reports the final output may be incomplete", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000, dir: tmp() });
    const sink: LiveSessionSink = {
      post: async () => { throw new Error("always fails"); },
      edit: async () => {},
    };
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink, onEnded: (n) => notices.push(n) });

    f.cbs().onOutput("final words");
    f.cbs().onExit(undefined);

    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(501);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("may be incomplete");
  });
});
