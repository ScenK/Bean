import { describe, expect, test } from "vitest";
import { flattenRuns, splitSteps, unreadRuns } from "../src/renderer/components/dashboard/runs.js";
import type { RoutineStateView } from "../src/ipc.js";

const record = (startedAt: string, finishedAt: string, ok: boolean[]) => ({
  startedAt,
  finishedAt,
  status: ok.every(Boolean) ? ("ok" as const) : ("failed" as const),
  digest: "digest",
  steps: ok.map((o, i) => ({ kind: "chat" as const, ok: o, summary: `step ${i + 1}` })),
});

const states: Record<string, RoutineStateView> = {
  nightly: {
    running: false,
    history: [record("2026-09-21T22:04:00Z", "2026-09-22T07:15:00Z", [true, false, true])],
  },
  weekly: {
    running: false,
    history: [
      record("2026-09-20T08:00:00Z", "2026-09-20T08:30:00Z", [true]),
      record("2026-09-13T08:00:00Z", "2026-09-13T08:30:00Z", [false]),
    ],
  },
};

describe("dashboard runs", () => {
  test("flattens every routine's history into one newest-first stream", () => {
    const runs = flattenRuns(states);
    expect(runs.map((r) => `${r.routine}@${r.startedAt}`)).toEqual([
      "nightly@2026-09-21T22:04:00Z",
      "weekly@2026-09-20T08:00:00Z",
      "weekly@2026-09-13T08:00:00Z",
    ]);
    expect(runs[0]!.id).toBe("nightly@2026-09-21T22:04:00Z");
  });

  test("only failed steps need you; passing steps collapse into resolved", () => {
    const { needs, resolved } = splitSteps(flattenRuns(states)[0]);
    expect(needs.map((s) => s.index)).toEqual([1]);
    expect(resolved.map((s) => s.index)).toEqual([0, 2]);
  });

  test("no selected run means nothing needs you", () => {
    expect(splitSteps(undefined)).toEqual({ needs: [], resolved: [] });
  });

  test("unread is everything finished after the review mark, all runs when never reviewed", () => {
    const runs = flattenRuns(states);
    expect(unreadRuns(runs, null)).toHaveLength(3);
    expect(unreadRuns(runs, "2026-09-20T09:00:00Z").map((r) => r.routine)).toEqual(["nightly"]);
    expect(unreadRuns(runs, "2026-09-22T09:00:00Z")).toEqual([]);
  });
});
