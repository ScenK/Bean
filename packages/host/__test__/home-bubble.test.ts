import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeBubble, HOME_RECONCILE_MS } from "../src/home-bubble.js";
import { createTaskStatus, HOME_JOB_ID, type TaskJob } from "../src/task-status.js";

// The avatar's Home bubble (#961): recounted on insert, drain, boot and expiry; a post nudges the chat
// holding Home; a bounded reconcile catches posts another process inserted.
function setup(over: { mount?: string } = {}) {
  const pushes: TaskJob[][] = [];
  const status = createTaskStatus((jobs) => pushes.push(jobs));
  const db = { count: 0, newest: undefined as { id: string; createdAt: string } | undefined, expiry: undefined as string | undefined };
  const nudge = vi.fn();
  const bubble = createHomeBubble({
    count: () => db.count, newest: () => db.newest, nextExpiry: () => db.expiry, status, homeMount: () => over.mount, nudge,
  });
  const add = (id: string, createdAt = new Date().toISOString(), count = db.count + 1): void => { db.count = count; db.newest = { id, createdAt }; };
  const home = (): TaskJob | undefined => status.list().find((j) => j.id === HOME_JOB_ID);
  return { status, db, add, nudge, bubble, home, pushes };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Home bubble", () => {
  it("shows the pending count, never running, and leaves at zero (boot / drain recount)", () => {
    const { db, add, bubble, home } = setup();
    bubble.refresh();
    expect(home()).toBeUndefined();
    add("a");
    add("b");
    bubble.refresh(); // boot with posts left pending
    expect(home()).toMatchObject({ kind: "home", state: "done", count: 2, line: "Bean has 2 posts for you" });
    db.count = 0;
    db.newest = undefined;
    bubble.refresh(); // a drain
    expect(home()).toBeUndefined();
    bubble.stop();
  });

  it("a new post moves the bubble to the newest slot and nudges the chat holding Home; a recount keeps its place", () => {
    const { status, add, bubble, nudge } = setup({ mount: "m1" });
    add("a");
    bubble.refresh();
    status.upsert("d1", { kind: "delegate", name: "fix" });
    bubble.refresh();
    expect(status.list().map((j) => j.id)).toEqual([HOME_JOB_ID, "d1"]);
    expect(nudge).not.toHaveBeenCalled();
    add("b");
    bubble.posted();
    expect(nudge).toHaveBeenCalledWith("m1");
    expect(status.list().map((j) => j.id)).toEqual(["d1", HOME_JOB_ID]);
    bubble.stop();
  });

  it("the last pending post expiring removes the bubble with no other event", () => {
    const { db, add, bubble, home } = setup();
    add("a");
    db.expiry = new Date(Date.now() + 60_000).toISOString();
    bubble.refresh();
    expect(home()).toBeDefined();
    db.count = 0;
    db.newest = undefined;
    db.expiry = undefined;
    vi.advanceTimersByTime(60_000 + 100);
    expect(home()).toBeUndefined();
    bubble.stop();
  });

  it("reconciles posts another process inserted (bean-core holding the lease), also a same-count replacement at the cap", () => {
    const { status, add, bubble, home, nudge } = setup({ mount: "m1" });
    add("a", "2026-11-19T10:00:00.000Z");
    bubble.refresh();
    status.upsert("d1", { kind: "delegate", name: "fix" });
    vi.advanceTimersByTime(HOME_RECONCILE_MS); // nothing new
    expect(nudge).not.toHaveBeenCalled();
    expect(status.list().map((j) => j.id)).toEqual([HOME_JOB_ID, "d1"]);
    add("b", "2026-11-19T10:05:00.000Z", 1); // the cap dropped "a": same count
    vi.advanceTimersByTime(HOME_RECONCILE_MS);
    expect(nudge).toHaveBeenCalledWith("m1");
    expect(status.list().map((j) => j.id)).toEqual(["d1", HOME_JOB_ID]);
    expect(home()).toMatchObject({ count: 1 });
    bubble.stop();
  });

  it("an expiry or drain recount that runs first still treats another process's post as an arrival", () => {
    const { db, add, bubble, nudge, status } = setup({ mount: "m1" });
    add("a", "2026-11-19T10:00:00.000Z");
    db.expiry = new Date(Date.now() + 1_000).toISOString();
    bubble.refresh();
    status.upsert("d1", { kind: "delegate", name: "fix" });
    add("b", "2026-11-19T10:05:00.000Z"); // inserted elsewhere
    db.count = 1; // "a" expired
    db.expiry = undefined;
    vi.advanceTimersByTime(1_100); // the expiry recount, before the reconcile
    expect(nudge).toHaveBeenCalledWith("m1");
    expect(status.list().map((j) => j.id)).toEqual(["d1", HOME_JOB_ID]);
    nudge.mockClear();
    vi.advanceTimersByTime(HOME_RECONCILE_MS); // nothing newer since
    expect(nudge).not.toHaveBeenCalled();
    bubble.stop();
  });

  it("a failed count leaves the bubble as it was", () => {
    const pushes: TaskJob[][] = [];
    const status = createTaskStatus((jobs) => pushes.push(jobs));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bubble = createHomeBubble({
      count: () => { throw new Error("db locked"); }, newest: () => undefined, nextExpiry: () => undefined, status,
      homeMount: () => undefined, nudge: () => {},
    });
    bubble.refresh();
    bubble.posted();
    expect(pushes).toEqual([]);
    bubble.stop();
    err.mockRestore();
  });
});
