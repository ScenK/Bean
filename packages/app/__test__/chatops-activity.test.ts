import { afterEach, expect, it, vi } from "vitest";
import { applyChatopsActivity, clearBotJobs } from "../src/chatops-activity.js";
import { createTaskStatus, FINISHED_LINGER_MS } from "../src/task-status.js";

afterEach(() => { vi.useRealTimers(); });

it("a bot turn shows while it runs and leaves only a failure behind", () => {
  const s = createTaskStatus(() => {});
  applyChatopsActivity(s, "discord", { type: "turn", phase: "start", id: "t1", who: "alice", where: "#dev" });
  expect(s.list()).toMatchObject([{ id: "discord:turn:t1", kind: "chat", name: "Discord · #dev", line: "Replying to alice…", state: "running" }]);
  applyChatopsActivity(s, "discord", { type: "turn", phase: "end", id: "t1", who: "alice" });
  expect(s.list()).toEqual([]);
  applyChatopsActivity(s, "discord", { type: "turn", phase: "start", id: "t2", who: "bob" });
  applyChatopsActivity(s, "discord", { type: "turn", phase: "end", id: "t2", who: "bob", error: "401" });
  expect(s.list()).toMatchObject([{ id: "discord:chat:error", state: "failed", line: "401" }]);
});

it("maps a run's lifecycle; a cancel lingers out, a failure sticks", () => {
  vi.useFakeTimers();
  const s = createTaskStatus(() => {});
  applyChatopsActivity(s, "teams", { type: "run", phase: "start", id: "r1", name: "api" });
  expect(s.list()).toMatchObject([{ id: "teams:run:r1", kind: "delegate", name: "api · Teams", line: "Running…" }]);
  applyChatopsActivity(s, "teams", { type: "run", phase: "cancelled", id: "r1", name: "api" });
  applyChatopsActivity(s, "teams", { type: "run", phase: "start", id: "r2", name: "web" });
  applyChatopsActivity(s, "teams", { type: "run", phase: "failed", id: "r2", name: "web", error: "exit 1" });
  vi.advanceTimersByTime(FINISHED_LINGER_MS);
  expect(s.list()).toMatchObject([{ id: "teams:run:r2", state: "failed", line: "exit 1" }]);
});

it("a stopped bot closes only its own running jobs", () => {
  const s = createTaskStatus(() => {});
  applyChatopsActivity(s, "discord", { type: "live", phase: "start", id: "c1", name: "api" });
  applyChatopsActivity(s, "teams", { type: "turn", phase: "start", id: "t1", who: "bob" });
  s.error("bot:discord", { kind: "bot", name: "Discord", line: "crashed" });
  clearBotJobs(s, "discord");
  expect(s.list().map((j) => [j.id, j.state, j.line])).toEqual([
    ["discord:live:c1", "failed", "Bot stopped"],
    ["teams:turn:t1", "running", "Replying to bob…"],
    ["bot:discord", "failed", "crashed"],
  ]);
});
