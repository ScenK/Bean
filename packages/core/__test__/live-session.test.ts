import { describe, expect, it } from "vitest";
import { claudeTurnSummary, liveSessionCommand, userTurnLine } from "../src/live-session.js";

describe("liveSessionCommand", () => {
  it("builds the multi-turn stream-json claude invocation with permissions bypassed", () => {
    const { command, args } = liveSessionCommand({ projectPath: "/p", prompt: "hi" });
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
  });

  it("appends --model verbatim when set", () => {
    const { args } = liveSessionCommand({ projectPath: "/p", prompt: "hi", model: "sonnet" });
    expect(args.slice(-2)).toEqual(["--model", "sonnet"]);
  });
});

describe("userTurnLine", () => {
  it("emits one newline-terminated stream-json user message", () => {
    const line = userTurnLine("fix the bug");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    });
  });
});

describe("claudeTurnSummary", () => {
  it("extracts result, duration, and cost from a result event", () => {
    expect(claudeTurnSummary({ type: "result", result: "done", duration_ms: 1200, total_cost_usd: 0.004 }))
      .toEqual({ result: "done", durationMs: 1200, costUsd: 0.004 });
  });

  it("tolerates a result event missing optional fields", () => {
    expect(claudeTurnSummary({ type: "result" })).toEqual({ result: "", durationMs: undefined, costUsd: undefined });
  });

  it("returns undefined for non-result events", () => {
    expect(claudeTurnSummary({ type: "assistant" })).toBeUndefined();
    expect(claudeTurnSummary(null)).toBeUndefined();
  });
});
