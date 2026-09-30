import { describe, expect, it } from "vitest";
import type { Routine } from "@bean/core";
import { intervalShort, intervalText, watchDashboardText, watchRowSub, watchStatusLine } from "../src/renderer/components/routines/watch-status.js";
import type { RoutineStateView } from "../src/ipc.js";

const now = new Date("2026-09-28T12:00:00Z");
const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const r = (over: Partial<Routine> = {}): Routine => ({
  name: "prs", enabled: true, todoDriven: true, watch: { kind: "command", command: "c", everyMinutes: 5 },
  steps: [{ kind: "chat", instruction: "x" }], sinks: {}, ...over,
});
const st = (over: Partial<RoutineStateView> = {}): RoutineStateView => ({ history: [], running: false, seeded: true, ...over });

describe("watch status wording", () => {
  it("idle / first failure / escalated", () => {
    expect(watchStatusLine(r(), st({ lastPoll: ago(2) }), now).text).toBe("Checks every 5 min · last checked 2m ago · nothing new");
    const first = watchStatusLine(r(), st({ lastPoll: ago(2), pollError: "exit 4", pollFailures: 1 }), now);
    expect(first).toMatchObject({ tone: "warn", text: "Last check failed · 2m ago · retrying in 3m", detail: "exit 4" });
    expect(watchStatusLine(r(), st({ lastPoll: ago(18), pollError: "302", pollFailures: 4 }), now))
      .toMatchObject({ tone: "bad", text: "Last 4 checks failed · 18m ago" });
  });

  it("notify-only reports the last new item from history", () => {
    const line = watchStatusLine(r({ steps: [], todoDriven: undefined }), st({
      lastPoll: ago(1), history: [{ startedAt: ago(180), finishedAt: ago(180), status: "ok", digest: "", steps: [] }],
    }), now);
    expect(line.text).toContain("last new item 3h ago");
  });

  it("list rows: needs review, failing, notify only", () => {
    expect(watchRowSub(r({ enabled: false }), st({ seeded: false })).text).toBe("needs review · Enable to start");
    expect(watchRowSub(r(), st({ pollError: "x" }))).toEqual({ text: "Watch · 5m · check failing", bad: true });
    expect(watchRowSub(r({ steps: [] }), st()).text).toBe("Watch · 5m · notify only");
  });

  it("dashboard: watching / running / error only after the alarm", () => {
    expect(watchDashboardText(r(), st({ lastPoll: ago(2) }), now)).toBe("watching for new items · checked 2m ago");
    expect(watchDashboardText(r(), st({ queue: { running: 1, pending: 1 } }), now)).toBe("running 1 item now · 1 queued");
    expect(watchDashboardText(r(), st({ lastPoll: ago(2), pollError: "x", pollFailures: 2 }), now)).toContain("watching");
    expect(watchDashboardText(r({ watch: { kind: "feed", url: "https://f" } }), st({ lastPoll: ago(18), pollError: "x", pollFailures: 3 }), now))
      .toBe("can't check the feed · failing since 18m ago");
  });
});

describe("watch intervals", () => {
  it("reads hour/day multiples as hours/days, anything else as minutes", () => {
    expect([15, 60, 360, 1440, 2880, 90].map(intervalText)).toEqual(["15 min", "hour", "6 hours", "day", "2 days", "90 min"]);
    expect([15, 360, 1440].map(intervalShort)).toEqual(["15m", "6h", "1d"]);
  });

  it("daily watches say so in the status line, row caption, and retry hint", () => {
    const daily = r({ watch: { kind: "command", command: "c", everyMinutes: 1440 } });
    expect(watchStatusLine(daily, st({ lastPoll: ago(2) }), now).text).toBe("Checks every day · last checked 2m ago · nothing new");
    expect(watchRowSub(daily, st()).text).toBe("Watch · 1d · ⚡ todo-driven");
    expect(watchStatusLine(daily, st({ lastPoll: ago(60), pollError: "x" }), now).text).toBe("Last check failed · 1h ago · retrying in 23h");
    const hourly = r({ watch: { kind: "command", command: "c", everyMinutes: 120 } });
    expect(watchStatusLine(hourly, st({ lastPoll: ago(31), pollError: "x" }), now).text).toBe("Last check failed · 31m ago · retrying in 1h 29m");
  });
});
