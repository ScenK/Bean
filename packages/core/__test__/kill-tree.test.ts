import { afterEach, describe, expect, it, vi } from "vitest";
import { escalateKill, killPendingGroups, killTree, treeGroups } from "../src/kill-tree.js";

// pid ppid pgid — 100 is the CLI (own group); 200 a tool in its own group with a child in the
// same group (201) and a grandchild in a third group (300); 999 is unrelated.
const PS = `
    1     0     1
  100     1   100
  101   100   100
  200   100   200
  201   200   200
  300   201   300
  999     1   999
garbage line
`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("treeGroups", () => {
  it("collects every descendant's pgid once, plus the root's own group", () => {
    expect(treeGroups(100, () => PS)).toEqual([100, 200, 300]);
  });

  it("degrades to the plain group when ps fails", () => {
    expect(treeGroups(100, () => { throw new Error("ps missing"); })).toEqual([100]);
  });
});

describe("killTree / escalateKill", () => {
  it("signals every collected group and returns them", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(killTree(100, "SIGTERM", () => PS)).toEqual([100, 200, 300]);
    expect(kill.mock.calls).toEqual([[-100, "SIGTERM"], [-200, "SIGTERM"], [-300, "SIGTERM"]]);
  });

  it("SIGKILLs the saved groups after the grace period, tolerating gone groups", () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
    escalateKill([100, 200]);
    vi.advanceTimersByTime(4_999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill.mock.calls).toEqual([[-100, "SIGKILL"], [-200, "SIGKILL"]]);
  });

  it("killPendingGroups reaches a pending escalation at once, and the timer then stays quiet", () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    escalateKill([100, 200]);
    killPendingGroups();
    expect(kill.mock.calls).toEqual([[-100, "SIGKILL"], [-200, "SIGKILL"]]);
    vi.advanceTimersByTime(5_000);
    killPendingGroups();
    expect(kill).toHaveBeenCalledTimes(2);
  });
});
