import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutineBubbles, createTaskStatus, FINISHED_LINGER_MS, type TaskJob } from "../src/task-status.js";

afterEach(() => { vi.useRealTimers(); });

describe("createTaskStatus", () => {
  it("creates, patches, lingers a finished job briefly, then drops it", () => {
    vi.useFakeTimers();
    const sent: TaskJob[][] = [];
    const s = createTaskStatus((j) => sent.push(j));
    s.upsert("a", { kind: "routine", name: "nightly", steps: ["one", "two"], step: 0 });
    s.upsert("a", { step: 1, line: "two" });
    s.upsert("ghost", { line: "no kind/name, never created" });
    expect(s.list()).toMatchObject([{ id: "a", step: 1, line: "two", state: "running" }]);

    s.finish("a", "done", "Done");
    expect(s.list()[0]!.state).toBe("done");
    vi.advanceTimersByTime(FINISHED_LINGER_MS - 1);
    expect(s.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(s.list()).toEqual([]);
    expect(sent.at(-1)).toEqual([]);
  });

  it("a rerun during the linger cancels the pending removal", () => {
    vi.useFakeTimers();
    const s = createTaskStatus(() => {});
    s.upsert("a", { kind: "routine", name: "nightly" });
    s.finish("a", "failed", "Failed");
    s.upsert("a", { kind: "routine", name: "nightly", state: "running" });
    vi.advanceTimersByTime(FINISHED_LINGER_MS * 2);
    expect(s.list()).toMatchObject([{ id: "a", state: "running" }]);
  });

  it("keeps a failure until dismissed; a non-sticky failure (user Stop) still lingers out", () => {
    vi.useFakeTimers();
    const s = createTaskStatus(() => {});
    s.upsert("a", { kind: "delegate", name: "repo" });
    s.finish("a", "failed", "boom");
    s.upsert("b", { kind: "delegate", name: "repo" });
    s.finish("b", "failed", "Stopped", false);
    vi.advanceTimersByTime(FINISHED_LINGER_MS * 10);
    expect(s.list().map((j) => j.id)).toEqual(["a"]);
    s.dismiss("a");
    expect(s.list()).toEqual([]);
  });

  it("merges repeated errors on one id into a counted bubble", () => {
    const s = createTaskStatus(() => {});
    s.error("bot:discord", { kind: "bot", name: "Discord", line: "crash 1" });
    s.error("bot:discord", { kind: "bot", name: "Discord", line: "crash 2" });
    expect(s.list()).toMatchObject([{ id: "bot:discord", state: "failed", count: 2, line: "crash 2" }]);
  });

  // The bubble id is reused per routine: a rerun whose run wasn't recorded must not open the
  // previous run's record.
  it("finish sets runStartedAt; a rerun never inherits the last run's", () => {
    const s = createTaskStatus(() => {});
    s.upsert("routine:r", { kind: "routine", name: "r", runStartedAt: undefined });
    s.finish("routine:r", "done", "Done", undefined, { runStartedAt: "2026-10-23T06:00:00.000Z" });
    expect(s.list()[0]!.runStartedAt).toBe("2026-10-23T06:00:00.000Z");
    s.upsert("routine:r", { kind: "routine", name: "r", state: "running", runStartedAt: undefined });
    expect(s.list()[0]!.runStartedAt).toBeUndefined();
    s.finish("routine:r", "failed", "Run failed", undefined, { runStartedAt: undefined });
    expect(s.list()[0]).toMatchObject({ state: "failed", runStartedAt: undefined });
  });
});

describe("createRoutineBubbles", () => {
  const start = (id: string, name: string, routine: string) =>
    ({ type: "start" as const, id, name, routine, detail: "", steps: ["one", "two"], startedAt: 1 });

  it("a Stop marks that sprout's running bubbles Stopping…, step events can't overwrite it, and a stopped finish lingers out", () => {
    vi.useFakeTimers();
    const s = createTaskStatus(() => {});
    const b = createRoutineBubbles(s);
    b.onStatus(start("routine:r:1", "fix the login bug", "r"));
    b.onStatus(start("routine:r:2", "add a test", "r"));
    b.onStatus(start("routine:other", "other", "other"));
    expect(s.list()[0]).toMatchObject({ name: "fix the login bug", routine: "r" });

    b.stopping("r");
    b.onStatus({ type: "step", id: "routine:r:1", step: 1, line: "two" });
    b.onStatus({ type: "step", id: "routine:other", step: 1, line: "two" });
    expect(s.list().map((j) => j.line)).toEqual(["Stopping…", "Stopping…", "two"]);

    b.onStatus({ type: "finish", id: "routine:r:1", state: "failed", line: "Stopped", startedAt: "t", stopped: true });
    expect(s.list()[0]).toMatchObject({ state: "failed", line: "Stopped", runStartedAt: "t" });
    vi.advanceTimersByTime(FINISHED_LINGER_MS);
    expect(s.list().map((j) => j.id)).toEqual(["routine:r:2", "routine:other"]);
  });

  it("an ordinary failed finish stays sticky; a rerun of a stopped id takes step events again", () => {
    vi.useFakeTimers();
    const s = createTaskStatus(() => {});
    const b = createRoutineBubbles(s);
    b.onStatus(start("routine:r", "r", "r"));
    b.stopping("r");
    b.onStatus({ type: "finish", id: "routine:r", state: "done", line: "Done · 2 steps" }); // stop landed too late
    b.onStatus(start("routine:r", "r", "r"));
    b.onStatus({ type: "step", id: "routine:r", step: 1, line: "two" });
    expect(s.list()[0]!.line).toBe("two");
    b.onStatus({ type: "finish", id: "routine:r", state: "failed", line: "Finished with a failed step" });
    vi.advanceTimersByTime(FINISHED_LINGER_MS * 2);
    expect(s.list()).toMatchObject([{ state: "failed" }]);
  });
});
