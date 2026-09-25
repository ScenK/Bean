import { expect, test } from "vitest";
import { parseChatopsActivity } from "../src/chatops/activity.js";

test("accepts well-formed events and drops unknown fields", () => {
  expect(parseChatopsActivity({ type: "turn", phase: "start", id: "t1", who: "alice", where: "#dev", text: "secret" }))
    .toEqual({ type: "turn", phase: "start", id: "t1", who: "alice", where: "#dev", error: undefined });
  expect(parseChatopsActivity({ type: "run", phase: "tail", id: "r1", name: "api", line: "x" }))
    .toEqual({ type: "run", phase: "tail", id: "r1", name: "api", line: "x" });
});

test("rejects malformed events", () => {
  for (const bad of [null, "turn", {}, { type: "turn", phase: "tail", id: "t" }, { type: "run", phase: "start" },
    { type: "toString", phase: "start", id: "x" }, { type: "live", phase: "start", id: 5 }]) {
    expect(parseChatopsActivity(bad)).toBeUndefined();
  }
});

test("caps string lengths", () => {
  const e = parseChatopsActivity({ type: "run", phase: "failed", id: "r", name: "n", line: "x".repeat(5000) });
  expect(e?.type === "run" && e.line?.length).toBe(300);
});
