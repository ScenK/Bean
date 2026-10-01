import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKeepAwake, keepAwakeFile, keepAwakeTooltip, loadKeepAwake, saveKeepAwake } from "../src/keep-awake.js";
import type { TaskJob } from "../src/task-status.js";

const job = (id: string, kind: TaskJob["kind"], state: TaskJob["state"] = "running"): TaskJob =>
  ({ id, kind, name: id, line: "", detail: "", startedAt: 0, state });

function setup() {
  let next = 1;
  const start = vi.fn((_type: string) => next++);
  const stop = vi.fn();
  const onChange = vi.fn();
  return { start, stop, onChange, ka: createKeepAwake({ start, stop, onChange }) };
}

describe("keep awake controller", () => {
  it("holds while always-on and releases when switched off", () => {
    const { start, stop, onChange, ka } = setup();
    ka.setAlwaysOn(true);
    expect(ka.held().system).toBe(true);
    ka.setAlwaysOn(false);
    expect(ka.held().system).toBe(false);
    expect(start.mock.calls).toEqual([["prevent-app-suspension"]]);
    expect(stop).toHaveBeenCalledWith(1);
    expect(onChange.mock.calls).toEqual([[{ system: true, display: false }], [{ system: false, display: false }]]);
  });

  it("holds for running delegate/routine work until the last job ends", () => {
    const { start, stop, ka } = setup();
    ka.setJobs([job("a", "delegate")]);
    ka.setJobs([job("a", "delegate"), job("b", "routine")]);
    ka.setJobs([job("a", "delegate", "done"), job("b", "routine")]);
    expect(ka.held().system).toBe(true);
    ka.setJobs([job("a", "delegate", "done"), job("b", "routine", "failed")]);
    expect(ka.held().system).toBe(false);
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
    expect(ka.held().system).toBe(true);
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
    expect(ka.held().system).toBe(false);
  });

  it("keeps the id when stop throws, so the next change retries", () => {
    const stop = vi.fn().mockImplementationOnce(() => { throw new Error("nope"); });
    const start = vi.fn(() => 7);
    const ka = createKeepAwake({ start, stop });
    ka.setAlwaysOn(true);
    ka.setAlwaysOn(false);
    expect(ka.held().system).toBe(true);
    ka.setJobs([]);
    expect(ka.held().system).toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("keep display on", () => {
  it("starts and stops only the display id", () => {
    const { start, stop, ka } = setup();
    ka.setAlwaysOn(true); // id 1 = system
    ka.setDisplay(true); // id 2 = display
    expect(start.mock.calls).toEqual([["prevent-app-suspension"], ["prevent-display-sleep"]]);
    ka.setDisplay(false);
    expect(stop.mock.calls).toEqual([[2]]);
    expect(ka.held()).toEqual({ system: true, display: false });
  });

  it("drops both with always-on, keeps the flag, and restores both", () => {
    const { start, stop, ka } = setup();
    ka.setAlwaysOn(true);
    ka.setDisplay(true);
    ka.setAlwaysOn(false);
    expect(stop.mock.calls.map(([id]) => id).sort()).toEqual([1, 2]);
    expect(ka.display()).toBe(true);
    expect(ka.held()).toEqual({ system: false, display: false });
    ka.setAlwaysOn(true);
    expect(ka.held()).toEqual({ system: true, display: true });
    expect(start).toHaveBeenCalledTimes(4);
  });

  it("keeps the system hold for a running job when always-on goes off", () => {
    const { ka } = setup();
    ka.setJobs([job("a", "delegate")]);
    ka.setAlwaysOn(true);
    ka.setDisplay(true);
    ka.setAlwaysOn(false);
    expect(ka.held()).toEqual({ system: true, display: false });
  });

  it("holds nothing with display on and always-on off, and work never holds the display", () => {
    const { start, ka } = setup();
    ka.setDisplay(true);
    expect(start).not.toHaveBeenCalled();
    ka.setJobs([job("a", "delegate")]);
    expect(start.mock.calls).toEqual([["prevent-app-suspension"]]);
  });

  it("starts each type once across repeated identical updates", () => {
    const { start, ka } = setup();
    for (let i = 0; i < 5; i++) { ka.setAlwaysOn(true); ka.setDisplay(true); ka.setJobs([job("a", "delegate")]); }
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("keeps the system hold when the display start throws", () => {
    const start = vi.fn((type: string) => { if (type === "prevent-display-sleep") throw new Error("nope"); return 1; });
    const ka = createKeepAwake({ start, stop: () => {} });
    ka.setDisplay(true);
    ka.setAlwaysOn(true);
    expect(ka.held()).toEqual({ system: true, display: false });
  });

  it("derives the tooltip from held ids", () => {
    expect(keepAwakeTooltip({ system: false, display: false })).toBe("Bean");
    expect(keepAwakeTooltip({ system: true, display: false })).toBe("Bean — keeping Mac awake");
    expect(keepAwakeTooltip({ system: true, display: true })).toBe("Bean — keeping Mac and display awake");
  });
});

describe("keep awake store", () => {
  it("round-trips both fields, reads legacy files with display off, and missing/invalid as off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bean-keep-awake-"));
    const file = keepAwakeFile(dir);
    const off = { alwaysOn: false, display: false };
    expect(await loadKeepAwake(file)).toEqual(off);
    await saveKeepAwake(file, { alwaysOn: true, display: true });
    expect(await loadKeepAwake(file)).toEqual({ alwaysOn: true, display: true });
    await writeFile(file, JSON.stringify({ alwaysOn: true }), "utf8");
    expect(await loadKeepAwake(file)).toEqual({ alwaysOn: true, display: false });
    await writeFile(file, "{not json", "utf8");
    expect(await loadKeepAwake(file)).toEqual(off);
    await writeFile(file, "null", "utf8");
    expect(await loadKeepAwake(file)).toEqual(off);
  });
});
