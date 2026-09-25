import { expect, test } from "vitest";
import { parseChatopsActivity } from "../src/chatops/activity.js";

test("accepts well-formed events and drops unknown fields", () => {
  expect(parseChatopsActivity({ type: "turn", phase: "start", id: "t1", who: "alice", where: "#dev", text: "secret" }))
    .toEqual({ type: "turn", phase: "start", id: "t1", who: "alice", where: "#dev", error: undefined });
  // Runs never carry output or error text across (both come from the CLI's stdout/stderr).
  expect(parseChatopsActivity({ type: "run", phase: "failed", id: "r1", name: "api", error: "stderr", line: "output" }))
    .toEqual({ type: "run", phase: "failed", id: "r1", name: "api" });
});

test("rejects malformed events", () => {
  for (const bad of [null, "turn", {}, { type: "turn", phase: "tail", id: "t" }, { type: "run", phase: "start" },
    { type: "toString", phase: "start", id: "x" }, { type: "live", phase: "start", id: 5 },
    { type: "run", phase: "tail", id: "r" },
    // A coercion-throwing key must be rejected, not crash the parent's message handler.
    { type: { toString: null, valueOf: null }, phase: "start", id: "x" },
    { type: "run", phase: { toString: null, valueOf: null }, id: "x" }]) {
    expect(parseChatopsActivity(bad)).toBeUndefined();
  }
});

test("caps string lengths", () => {
  const e = parseChatopsActivity({ type: "turn", phase: "end", id: "t", who: "a", error: "x".repeat(5000) });
  expect(e?.type === "turn" && e.error?.length).toBe(300);
});
