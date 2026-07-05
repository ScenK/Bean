import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  delegateCommand,
  claudeTailLine,
  claudeResult,
  runDelegate,
  DELEGATE_TIMEOUT_MS,
  type DelegateCallbacks,
} from "../src/delegate.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = undefined;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

function collect(): { cbs: DelegateCallbacks; outputs: string[]; dones: string[]; errors: string[] } {
  const outputs: string[] = [];
  const dones: string[] = [];
  const errors: string[] = [];
  return {
    outputs, dones, errors,
    cbs: {
      onOutput: (l) => outputs.push(l),
      onDone: (r) => dones.push(r),
      onError: (e) => errors.push(e.message),
    },
  };
}

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

describe("runDelegate", () => {
  afterEach(() => vi.useRealTimers());

  it("spawns in the project directory", () => {
    const child = new FakeChild();
    const seen: { command: string; args: string[]; cwd: string }[] = [];
    runDelegate(
      { cli: "opencode", projectPath: "/my/project", prompt: "go" },
      collect().cbs,
      (command, args, cwd) => { seen.push({ command, args, cwd }); return asChild(child); },
    );
    expect(seen).toEqual([{ command: "opencode", args: ["run", "go"], cwd: "/my/project" }]);
  });

  it("claude: streams tail lines and resolves onDone with the result event", () => {
    const child = new FakeChild();
    const { cbs, outputs, dones } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }) + "\n" +
      JSON.stringify({ type: "result", subtype: "success", result: "Fixed it." }) + "\n",
    ));
    child.emit("close", 0);
    expect(outputs).toEqual(["▸ Edit"]);
    expect(dones).toEqual(["Fixed it."]);
  });

  it("claude: falls back to accumulated raw output when no result event arrives", () => {
    const child = new FakeChild();
    const { cbs, dones } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from("not json at all\n"));
    child.emit("close", 0);
    expect(dones).toEqual(["not json at all"]);
  });

  it("claude: passes unparsable lines through as raw tail output", () => {
    const child = new FakeChild();
    const { cbs, outputs } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from("warning: something\n"));
    expect(outputs).toEqual(["warning: something"]);
  });

  it("opencode: every line is tail and the whole stdout is the result, including a trailing partial line", () => {
    const child = new FakeChild();
    const { cbs, outputs, dones } = collect();
    runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from("line one\nline "));
    child.stdout.emit("data", Buffer.from("two"));
    child.emit("close", 0);
    expect(outputs).toEqual(["line one", "line two"]);
    expect(dones).toEqual(["line one\nline two"]);
  });

  it("reports a non-zero exit as onError with the stderr tail", () => {
    const child = new FakeChild();
    const { cbs, errors, dones } = collect();
    runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stderr.emit("data", Buffer.from("boom: no api key\n"));
    child.emit("close", 1);
    expect(dones).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("code 1");
    expect(errors[0]).toContain("boom: no api key");
  });

  it("reports a spawn error (ENOENT) as onError", () => {
    const child = new FakeChild();
    const { cbs, errors } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.emit("error", new Error("spawn claude ENOENT"));
    expect(errors).toEqual(["spawn claude ENOENT"]);
  });

  it("cancel kills the child and settles silently only after close", () => {
    const child = new FakeChild();
    const { cbs, outputs, dones, errors } = collect();
    const handle = runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    let cancelled = false;
    handle.cancel(() => { cancelled = true; });
    expect(child.killed).toBe(true);
    expect(cancelled).toBe(false);
    child.emit("close", 143);
    expect(cancelled).toBe(true);
    expect(outputs).toEqual([]);
    expect(dones).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("cancel escalates to SIGKILL when the child does not close", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const signals: NodeJS.Signals[] = [];
    child.kill = (signal?: NodeJS.Signals | number) => { signals.push(signal as NodeJS.Signals); return true; };
    const handle = runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, collect().cbs, () => asChild(child));
    handle.cancel();

    expect(signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(5_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("timeout waits for close before reporting onError", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { cbs, errors } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child), 60_000);
    vi.advanceTimersByTime(60_000);
    expect(child.killed).toBe(true);
    expect(errors).toEqual([]);
    child.emit("close", 143);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("timed out");
  });

  it("timeout escalates to SIGKILL when the child does not close", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const signals: NodeJS.Signals[] = [];
    child.kill = (signal?: NodeJS.Signals | number) => { signals.push(signal as NodeJS.Signals); return true; };
    const { cbs, errors } = collect();
    runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child), 60_000);

    vi.advanceTimersByTime(60_000);
    expect(signals).toEqual(["SIGTERM"]);
    expect(errors).toEqual([]);

    vi.advanceTimersByTime(5_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(errors).toEqual([]);

    child.emit("close", null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("timed out");
  });

  it("timeout still reports even if cancel is called before close", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { cbs, errors } = collect();
    const handle = runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child), 60_000);
    vi.advanceTimersByTime(60_000);
    handle.cancel(() => { throw new Error("cancel should not win after timeout"); });
    child.emit("close", 143);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("timed out");
  });

  it("exports a 30-minute default timeout", () => {
    expect(DELEGATE_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
