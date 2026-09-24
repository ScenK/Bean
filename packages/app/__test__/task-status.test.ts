import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskStatus, FINISHED_LINGER_MS, type TaskJob } from "../src/task-status.js";

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
});
