import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionRegistry, type LiveSessionSink } from "../src/chatops/live-sessions.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest } from "../src/live-session.js";

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
    const reg = new LiveSessionRegistry(f.startFn as never);
    const { sink } = fakeSink();
    expect(reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink })).toBe(true);
    expect(reg.has("c")).toBe(true);
    expect(reg.start({ channelId: "c", projectPath: "/p", instruction: "again", sink })).toBe(false);
  });

  it("posts buffered output on the throttle tick, then edits the same message", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
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
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
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
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
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
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
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
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onEnded: (n) => notices.push(n) });
    f.cbs().onExit(new Error("claude exited with code 1"));
    await flushTicks(reg, 1);
    expect(reg.has("c")).toBe(false);
    expect(notices[0]).toContain("code 1");
  });
});
