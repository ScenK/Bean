import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeBubble, HOME_ARRIVAL_GRACE_MS, HOME_RECONCILE_MS } from "../src/home-bubble.js";
import { createTaskStatus, HOME_JOB_ID, type TaskJob } from "../src/task-status.js";

// The avatar's Home bubble (#961): recounted on insert, drain, boot and expiry; a post for an open Home
// nudges it first and waits out the grace before the bubble shows.
function setup(over: { mount?: string } = {}) {
  const pushes: TaskJob[][] = [];
  const status = createTaskStatus((jobs) => pushes.push(jobs));
  const db = { count: 0, expiry: undefined as string | undefined };
  const nudge = vi.fn();
  const bubble = createHomeBubble({
    count: () => db.count, nextExpiry: () => db.expiry, status, homeMount: () => over.mount, nudge,
  });
  const home = (): TaskJob | undefined => status.list().find((j) => j.id === HOME_JOB_ID);
  return { status, db, nudge, bubble, home, pushes };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Home bubble", () => {
  it("shows the pending count, never running, and leaves at zero (boot / drain recount)", () => {
    const { db, bubble, home } = setup();
    bubble.refresh();
    expect(home()).toBeUndefined();
    db.count = 2;
    bubble.refresh(); // boot with posts left pending
    expect(home()).toMatchObject({ kind: "home", state: "done", count: 2, line: "Bean has 2 posts for you" });
    db.count = 0;
    bubble.refresh(); // a drain
    expect(home()).toBeUndefined();
  });

  it("a new post moves the bubble to the newest slot; a recount alone keeps its place", () => {
    const { status, db, bubble } = setup();
    db.count = 1;
    bubble.refresh();
    status.upsert("d1", { kind: "delegate", name: "fix" });
    bubble.refresh();
    expect(status.list().map((j) => j.id)).toEqual([HOME_JOB_ID, "d1"]);
    db.count = 2;
    bubble.posted();
    expect(status.list().map((j) => j.id)).toEqual(["d1", HOME_JOB_ID]);
  });

  it("a post for an open Home nudges it and shows the bubble only if it's still pending after the grace", () => {
    const { db, nudge, bubble, home } = setup({ mount: "m1" });
    db.count = 1;
    bubble.posted();
    expect(nudge).toHaveBeenCalledWith("m1");
    expect(home()).toBeUndefined();
    db.count = 0; // the shown Home drained it
    vi.advanceTimersByTime(HOME_ARRIVAL_GRACE_MS);
    expect(home()).toBeUndefined();
    db.count = 1; // a hidden Home doesn't
    bubble.posted();
    vi.advanceTimersByTime(HOME_ARRIVAL_GRACE_MS);
    expect(home()).toMatchObject({ count: 1 });
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
  });

  it("reconciles posts another process inserted (bean-core holding the lease): bubble, or a nudge to an open Home", () => {
    const { db, bubble, home, nudge } = setup();
    bubble.refresh();
    db.count = 1; // inserted elsewhere: no hook fires here
    vi.advanceTimersByTime(HOME_RECONCILE_MS);
    expect(home()).toMatchObject({ count: 1 });
    expect(nudge).not.toHaveBeenCalled();
    const open = setup({ mount: "m1" });
    open.bubble.refresh();
    open.db.count = 2;
    vi.advanceTimersByTime(HOME_RECONCILE_MS);
    expect(open.nudge).toHaveBeenCalledWith("m1");
    open.db.count = 0; // the shown Home drained them
    vi.advanceTimersByTime(HOME_ARRIVAL_GRACE_MS);
    expect(open.home()).toBeUndefined();
    bubble.stop();
    open.bubble.stop();
  });

  it("a failed count leaves the bubble as it was", () => {
    const pushes: TaskJob[][] = [];
    const status = createTaskStatus((jobs) => pushes.push(jobs));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bubble = createHomeBubble({
      count: () => { throw new Error("db locked"); }, nextExpiry: () => undefined, status, homeMount: () => undefined, nudge: () => {},
    });
    bubble.refresh();
    expect(pushes).toEqual([]);
    err.mockRestore();
  });
});
