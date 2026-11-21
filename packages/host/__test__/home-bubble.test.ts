import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeBubble, HOME_RECONCILE_MS } from "../src/home-bubble.js";
import { createTaskStatus, HOME_JOB_ID, type TaskJob } from "../src/task-status.js";

// The avatar's Home bubble (#961): the pending count is the only state — recounted on insert, drain,
// boot, expiry and a bounded poll.
function setup() {
  const pushes: TaskJob[][] = [];
  const status = createTaskStatus((jobs) => pushes.push(jobs));
  const db = { count: 0, expiry: undefined as string | undefined };
  const bubble = createHomeBubble({ count: () => db.count, nextExpiry: () => db.expiry, status });
  const home = (): TaskJob | undefined => status.list().find((j) => j.id === HOME_JOB_ID);
  return { status, db, bubble, home, pushes };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Home bubble", () => {
  it("shows the pending count, never running, and leaves at zero (boot / insert / drain recount)", () => {
    const { db, bubble, home } = setup();
    bubble.refresh();
    expect(home()).toBeUndefined();
    db.count = 2;
    bubble.refresh(); // boot with posts left pending
    expect(home()).toMatchObject({ kind: "home", state: "done", count: 2, line: "Bean has 2 posts for you" });
    db.count = 1;
    bubble.refresh();
    expect(home()).toMatchObject({ line: "Bean has 1 post for you" });
    db.count = 0;
    bubble.refresh(); // a drain
    expect(home()).toBeUndefined();
    bubble.stop();
  });

  it("is named after the persona, re-read on every recount (#1001)", () => {
    const status = createTaskStatus(() => {});
    let name = "Pip";
    const bubble = createHomeBubble({ count: () => 1, nextExpiry: () => undefined, name: () => name, status });
    bubble.refresh();
    expect(status.list().find((j) => j.id === HOME_JOB_ID)).toMatchObject({ name: "Pip", line: "Pip has 1 post for you" });
    name = "Mr. Bean";
    bubble.refresh();
    expect(status.list().find((j) => j.id === HOME_JOB_ID)).toMatchObject({ name: "Mr. Bean", line: "Mr. Bean has 1 post for you" });
    bubble.stop();
  });

  it("the last pending post expiring removes the bubble with no other event", () => {
    const { db, bubble, home } = setup();
    db.count = 1;
    db.expiry = new Date(Date.now() + 60_000).toISOString();
    bubble.refresh();
    expect(home()).toBeDefined();
    db.count = 0;
    db.expiry = undefined;
    vi.advanceTimersByTime(60_000 + 100);
    expect(home()).toBeUndefined();
    bubble.stop();
  });

  it("a standby host picks up another process's posts on the bounded poll", () => {
    const { db, bubble, home } = setup();
    bubble.refresh();
    db.count = 1; // inserted by the lease holder
    vi.advanceTimersByTime(HOME_RECONCILE_MS);
    expect(home()).toMatchObject({ count: 1 });
    bubble.stop();
  });

  it("a failed count leaves the bubble as it was", () => {
    const pushes: TaskJob[][] = [];
    const status = createTaskStatus((jobs) => pushes.push(jobs));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bubble = createHomeBubble({ count: () => { throw new Error("db locked"); }, nextExpiry: () => undefined, status });
    bubble.refresh();
    expect(pushes).toEqual([]);
    bubble.stop();
    err.mockRestore();
  });
});
