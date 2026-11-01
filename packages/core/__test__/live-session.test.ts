import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { claudeTurnSummary, liveSessionCommand, userTurnLine, startLiveSession, LIVE_SESSION_IDLE_MS, RESUME_REJECTED } from "../src/live-session.js";
import { withCliRules } from "../src/agent-rules.js";

describe("liveSessionCommand", () => {
  it("builds the multi-turn stream-json claude invocation with permissions bypassed and the browser on", () => {
    const { command, args } = liveSessionCommand({ projectPath: "/p", prompt: "hi" });
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--chrome",
    ]);
  });

  it("keeps --chrome on a resumed session", () => {
    expect(liveSessionCommand({ projectPath: "/p", prompt: "", resume: "3f2a-uuid" }).args).toContain("--chrome");
  });

  it("appends --resume <id> when continuing a session", () => {
    const { args } = liveSessionCommand({ projectPath: "/p", prompt: "hi", resume: "3f2a-uuid" });
    expect(args.slice(-2)).toEqual(["--resume", "3f2a-uuid"]);
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

function fakeChild(): {
  child: ChildProcess; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
  emit: (ev: string, ...a: unknown[]) => void;
} {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, pid: 4242, kill: vi.fn() });
  return { child, stdin, stdout, stderr, emit: (ev, ...a) => child.emit(ev, ...a) };
}

describe("startLiveSession", () => {
  it("writes the opening prompt (with git trailer) as the first stdin turn", () => {
    const f = fakeChild();
    const written: string[] = [];
    f.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    startLiveSession({ projectPath: "/p", prompt: "investigate" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {} }, () => f.child);
    const first = JSON.parse(written.join("").split("\n")[0]!);
    expect(first.message.content[0].text).toBe(withCliRules("investigate", "live"));
    expect(first.message.content[0].text).not.toContain("FAILED:");
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

  it("a signal-killed exit with no stop() call reports an error, not a clean end", () => {
    const f = fakeChild();
    let exitErr: Error | undefined | null = null;
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    // An external kill (an operator's `kill -9`, an OOM reaper) — not our own stop() path.
    // Node reports this the same way (code: null) as our own SIGTERM/SIGKILL escalation;
    // only `stopping` tells them apart.
    f.emit("close", null, "SIGKILL");
    expect(exitErr).toBeInstanceOf(Error);
    expect(exitErr?.message).toContain("SIGKILL");
  });

  it("drains stderr and includes its tail in a non-zero exit's error", () => {
    const f = fakeChild();
    let exitErr: Error | undefined;
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    f.stderr.write("some warning\nfatal: something broke\n");
    f.emit("close", 1);
    expect(exitErr?.message).toContain("code 1");
    expect(exitErr?.message).toContain("fatal: something broke");
  });

  it("draining stderr never crashes or blocks a clean exit", () => {
    const f = fakeChild();
    let exitErr: Error | undefined | null = null;
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    // A long-lived session can accumulate far more than the 4000-char tail buffer keeps.
    f.stderr.write("x".repeat(10_000));
    f.emit("close", 0);
    expect(exitErr).toBeUndefined();
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

describe("startLiveSession resume", () => {
  const rejection = JSON.stringify({ type: "result", is_error: true, result: "", errors: ["No conversation found"] }) + "\n";

  for (const code of [0, 1]) {
    it(`a resumed session that exits (code ${code}) before init reports the explicit failure, not a turn`, () => {
      const f = fakeChild();
      const spawn = vi.fn(() => f.child);
      const onExit = vi.fn();
      const onTurnComplete = vi.fn();
      startLiveSession({ projectPath: "/p", prompt: "go", resume: "s1" }, { onOutput: () => {}, onTurnComplete, onExit }, spawn);
      f.stdout.write(rejection);
      f.emit("close", code, null);
      expect(onTurnComplete).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledWith(new Error(RESUME_REJECTED));
      expect(spawn).toHaveBeenCalledTimes(1); // no fresh fallback
    });
  }

  it("a lazy resume (no prompt) spawns nothing until the first send, then opens with that text", () => {
    const f = fakeChild();
    const written: string[] = [];
    f.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    const spawn = vi.fn(() => f.child);
    const h = startLiveSession({ projectPath: "/p", prompt: "", resume: "s1" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {} }, spawn);
    expect(spawn).not.toHaveBeenCalled();
    expect(h.pid).toBeUndefined();
    h.send("what changed?");
    expect(spawn).toHaveBeenCalledWith("claude", expect.arrayContaining(["--resume", "s1"]), "/p");
    expect(h.pid).toBe(4242);
    const first = JSON.parse(written.join("").split("\n")[0]!);
    expect(first.message.content[0].text).toBe(withCliRules("what changed?", "live"));
    h.send("and then?");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("a lazy resume rejected on its first send fails with RESUME_REJECTED and never starts fresh", () => {
    const f = fakeChild();
    const spawn = vi.fn(() => f.child);
    const onExit = vi.fn();
    const h = startLiveSession({ projectPath: "/p", prompt: "", resume: "s1" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit }, spawn);
    h.send("hi");
    f.stdout.write(rejection);
    f.emit("close", 1, null);
    expect(onExit).toHaveBeenCalledWith(new Error(RESUME_REJECTED));
    h.send("again");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("a lazy resume that idles out or is stopped before any send ends cleanly with no spawn", () => {
    vi.useFakeTimers();
    const spawn = vi.fn();
    const idle = vi.fn();
    startLiveSession({ projectPath: "/p", prompt: "", resume: "s1" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: idle }, spawn, 1000);
    vi.advanceTimersByTime(1001);
    expect(idle).toHaveBeenCalledWith(undefined);
    const stopped = vi.fn();
    startLiveSession({ projectPath: "/p", prompt: "", resume: "s1" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: stopped }, spawn).stop();
    expect(stopped).toHaveBeenCalledWith(undefined);
    expect(spawn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("after init, a resumed session behaves like any other", () => {
    const f = fakeChild();
    const onExit = vi.fn();
    const onTurnComplete = vi.fn();
    startLiveSession({ projectPath: "/p", prompt: "go", resume: "s1" }, { onOutput: () => {}, onTurnComplete, onExit }, () => f.child);
    f.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n");
    f.stdout.write(JSON.stringify({ type: "result", result: "where things stand" }) + "\n");
    f.emit("close", 0, null);
    expect(onTurnComplete).toHaveBeenCalledWith(expect.objectContaining({ result: "where things stand" }));
    expect(onExit).toHaveBeenCalledWith(undefined);
  });
});

describe("startLiveSession onSessionId", () => {
  const init = (id: string): string => JSON.stringify({ type: "system", subtype: "init", session_id: id }) + "\n";
  const start = (resume?: string) => {
    const f = fakeChild();
    const ids: string[] = [];
    startLiveSession(
      { projectPath: "/p", prompt: "go", ...(resume ? { resume } : {}) },
      { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {}, onSessionId: (id) => ids.push(id) },
      () => f.child,
    );
    return { f, ids };
  };

  it("fires once from system/init; a later turn's init doesn't re-fire it", () => {
    const { f, ids } = start();
    f.stdout.write(init("sess-a"));
    f.stdout.write(JSON.stringify({ type: "result", result: "ok" }) + "\n");
    f.stdout.write(init("sess-a"));
    expect(ids).toEqual(["sess-a"]);
  });

  it("a resume fires with the matching id only; a rejected or mismatched resume never fires", () => {
    const ok = start("sess-a");
    ok.f.stdout.write(init("sess-a"));
    expect(ok.ids).toEqual(["sess-a"]);

    const rejected = start("sess-a");
    rejected.f.stdout.write(JSON.stringify({ type: "result", is_error: true, session_id: "sess-a" }) + "\n");
    rejected.f.emit("close", 1, null);
    expect(rejected.ids).toEqual([]);

    const other = start("sess-a");
    other.f.stdout.write(init("sess-b"));
    expect(other.ids).toEqual([]);
  });

  it("a throwing callback doesn't break the session", () => {
    const f = fakeChild();
    const turns: unknown[] = [];
    startLiveSession(
      { projectPath: "/p", prompt: "go" },
      { onOutput: () => {}, onTurnComplete: (t) => turns.push(t), onExit: () => {}, onSessionId: () => { throw new Error("db"); } },
      () => f.child,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.stdout.write(init("sess-a"));
    f.stdout.write(JSON.stringify({ type: "result", result: "ok" }) + "\n");
    warn.mockRestore();
    expect(turns).toHaveLength(1);
  });
});

describe("startLiveSession onTurnStart", () => {
  const ev = (o: object): string => JSON.stringify(o) + "\n";
  const init = ev({ type: "system", subtype: "init", session_id: "s1" });
  const assistant = ev({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
  const result = ev({ type: "result", result: "ok" });
  const start = (resume?: string) => {
    const f = fakeChild();
    const onTurnStart = vi.fn();
    const handle = startLiveSession(
      { projectPath: "/p", prompt: "go", ...(resume ? { resume } : {}) },
      { onOutput: () => {}, onTurnStart, onTurnComplete: () => {}, onExit: () => {} },
      () => f.child,
    );
    return { f, onTurnStart, handle };
  };

  it("fires once, on the init that opens a queued turn after a result", () => {
    const { f, onTurnStart } = start();
    f.stdout.write(init + assistant + result);
    expect(onTurnStart).not.toHaveBeenCalled(); // the opening turn already lit typing
    f.stdout.write(init + assistant + result);
    expect(onTurnStart).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first assistant event when no init follows the result", () => {
    const { f, onTurnStart } = start();
    f.stdout.write(init + result + assistant + assistant);
    expect(onTurnStart).toHaveBeenCalledTimes(1);
  });

  it("ignores other events after a result (system/thinking_tokens)", () => {
    const { f, onTurnStart } = start();
    f.stdout.write(init + result + ev({ type: "system", subtype: "thinking_tokens" }));
    expect(onTurnStart).not.toHaveBeenCalled();
  });

  it("a resume rejected before init never fires it", () => {
    const { f, onTurnStart } = start("s1");
    f.stdout.write(ev({ type: "result", is_error: true, result: "" }) + assistant);
    f.emit("close", 1, null);
    expect(onTurnStart).not.toHaveBeenCalled();
  });

  it("never fires after stop()", () => {
    const { f, onTurnStart, handle } = start();
    f.stdout.write(init);
    handle.stop();
    f.stdout.write(result + init + assistant);
    expect(onTurnStart).not.toHaveBeenCalled();
  });
});
