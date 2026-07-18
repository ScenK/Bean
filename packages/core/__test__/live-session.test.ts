import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { claudeTurnSummary, liveSessionCommand, userTurnLine, startLiveSession, LIVE_SESSION_IDLE_MS } from "../src/live-session.js";

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

function fakeChild(): { child: ChildProcess; stdin: PassThrough; stdout: PassThrough; emit: (ev: string, ...a: unknown[]) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: vi.fn() });
  return { child, stdin, stdout, emit: (ev, ...a) => child.emit(ev, ...a) };
}

describe("startLiveSession", () => {
  it("writes the opening prompt (with git trailer) as the first stdin turn", () => {
    const f = fakeChild();
    const written: string[] = [];
    f.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    startLiveSession({ projectPath: "/p", prompt: "investigate" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {} }, () => f.child);
    const first = JSON.parse(written.join("").split("\n")[0]!);
    expect(first.message.content[0].text).toContain("investigate");
    expect(first.message.content[0].text).toContain("Co-Authored-By: Bean");
  });

  it("streams assistant tail lines and per-turn summaries, and send() writes further turns", () => {
    const f = fakeChild();
    // Attach the stdin listener before startLiveSession's constructor write, same as the
    // opening-prompt test above — a PassThrough only replays buffered writes to a listener
    // added after the fact on a later tick, so a listener attached post-hoc would miss it.
    const written: string[] = [];
    f.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    const outputs: string[] = [];
    const turns: unknown[] = [];
    const handle = startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: (l) => outputs.push(l), onTurnComplete: (s) => turns.push(s), onExit: () => {} }, () => f.child);
    f.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "looking" }] } }) + "\n");
    f.stdout.write(JSON.stringify({ type: "result", result: "found it", duration_ms: 10 }) + "\n");
    expect(outputs).toEqual(["looking"]);
    expect(turns).toEqual([{ result: "found it", durationMs: 10, costUsd: undefined }]);
    handle.send("next hint");
    const lines = written.join("").split("\n").filter((l) => l.trim());
    expect(JSON.parse(lines[lines.length - 1]!).message.content[0].text).toBe("next hint");
  });

  it("stop() SIGTERMs the process group and close then reports a clean exit", () => {
    const f = fakeChild();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let exitErr: Error | undefined | null = null;
    const handle = startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    handle.stop();
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    f.emit("close", null);
    expect(exitErr).toBeUndefined();
    killSpy.mockRestore();
  });

  it("a non-zero exit without stop() reports an error", () => {
    const f = fakeChild();
    let exitErr: Error | undefined;
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    f.emit("close", 1);
    expect(exitErr?.message).toContain("code 1");
  });

  it("kills the session after the idle timeout", () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {} }, () => f.child, 1000);
    vi.advanceTimersByTime(1001);
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    killSpy.mockRestore();
    vi.useRealTimers();
  });
});
