import { describe, expect, it } from "vitest";
import { delegateCommand, claudeTailLine, claudeResult } from "../src/delegate.js";

describe("delegateCommand", () => {
  it("maps claude to headless -p with stream-json and the explicit tool allowlist", () => {
    const { command, args } = delegateCommand({ cli: "claude", projectPath: "/p", prompt: "fix the bug" });
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p", "fix the bug",
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep",
    ]);
  });

  it("maps opencode to headless run", () => {
    const { command, args } = delegateCommand({ cli: "opencode", projectPath: "/p", prompt: "fix the bug" });
    expect(command).toBe("opencode");
    expect(args).toEqual(["run", "fix the bug"]);
  });
});

describe("claudeTailLine", () => {
  it("turns assistant text blocks into a tail line", () => {
    const event = { type: "assistant", message: { content: [{ type: "text", text: "Looking at router.ts" }] } };
    expect(claudeTailLine(event)).toBe("Looking at router.ts");
  });

  it("turns tool_use blocks into a ▸-prefixed tail line", () => {
    const event = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } };
    expect(claudeTailLine(event)).toBe("▸ Edit");
  });

  it("joins mixed blocks with a separator", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Fixing" }, { type: "tool_use", name: "Bash", input: {} }] },
    };
    expect(claudeTailLine(event)).toBe("Fixing · ▸ Bash");
  });

  it("returns undefined for non-assistant events and empty content", () => {
    expect(claudeTailLine({ type: "system", subtype: "init" })).toBeUndefined();
    expect(claudeTailLine({ type: "assistant", message: { content: [] } })).toBeUndefined();
    expect(claudeTailLine("not an object")).toBeUndefined();
  });
});

describe("claudeResult", () => {
  it("extracts the final result string from a result event", () => {
    expect(claudeResult({ type: "result", subtype: "success", result: "All tests pass." })).toBe("All tests pass.");
  });

  it("returns undefined for anything else", () => {
    expect(claudeResult({ type: "assistant", message: { content: [] } })).toBeUndefined();
    expect(claudeResult({ type: "result", result: 42 })).toBeUndefined();
    expect(claudeResult(null)).toBeUndefined();
  });
});
