import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKeepAwake, keepAwakeFile, loadKeepAwake, saveKeepAwake } from "../src/keep-awake.js";
import type { TaskJob } from "../src/task-status.js";

const job = (id: string, kind: TaskJob["kind"], state: TaskJob["state"] = "running"): TaskJob =>
  ({ id, kind, name: id, line: "", detail: "", startedAt: 0, state });

function setup() {
  let next = 1;
  const start = vi.fn(() => next++);
  const stop = vi.fn();
  const onChange = vi.fn();
  return { start, stop, onChange, ka: createKeepAwake({ start, stop, onChange }) };
}

describe("keep awake controller", () => {
  it("holds while always-on and releases when switched off", () => {
    const { start, stop, onChange, ka } = setup();
    ka.setAlwaysOn(true);
    expect(ka.held()).toBe(true);
    ka.setAlwaysOn(false);
    expect(ka.held()).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(1);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("holds for running delegate/routine work until the last job ends", () => {
    const { start, stop, ka } = setup();
    ka.setJobs([job("a", "delegate")]);
    ka.setJobs([job("a", "delegate"), job("b", "routine")]);
    ka.setJobs([job("a", "delegate", "done"), job("b", "routine")]);
    expect(ka.held()).toBe(true);
    ka.setJobs([job("a", "delegate", "done"), job("b", "routine", "failed")]);
    expect(ka.held()).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores non-work kinds", () => {
    const { start, ka } = setup();
    ka.setJobs([job("c", "chat"), job("b", "bot"), job("r", "reminder"), job("m", "memory")]);
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps the hold when always-on outlives a job", () => {
    const { stop, ka } = setup();
    ka.setJobs([job("a", "delegate")]);
    ka.setAlwaysOn(true);
    ka.setJobs([]);
    expect(ka.held()).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it("starts once across repeated identical updates", () => {
    const { start, ka } = setup();
    for (let i = 0; i < 5; i++) ka.setJobs([job("a", "delegate")]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("swallows blocker errors", () => {
    const ka = createKeepAwake({ start: () => { throw new Error("nope"); }, stop: () => {} });
    expect(() => ka.setAlwaysOn(true)).not.toThrow();
    expect(ka.held()).toBe(false);
  });
});

describe("keep awake store", () => {
  it("round-trips, and reads missing/invalid as off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bean-keep-awake-"));
    const file = keepAwakeFile(dir);
    expect(await loadKeepAwake(file)).toBe(false);
    await saveKeepAwake(file, true);
    expect(await loadKeepAwake(file)).toBe(true);
    await writeFile(file, "{not json", "utf8");
    expect(await loadKeepAwake(file)).toBe(false);
  });
});
