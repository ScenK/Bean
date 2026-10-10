import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_SESSION_MISMATCH, OPENCODE_SIGNED_OUT, startOpencodeLiveSession } from "../src/opencode-live-session.js";
import { killPendingGroups } from "../src/kill-tree.js";
import { RESUME_REJECTED, type TurnSummary } from "../src/live-session.js";

// killTree's `ps` snapshot (kill-tree.ts): the CLI (pid) has one tool child in its own group.
const ps = vi.hoisted(() => ({ out: "" }));
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: () => ps.out }));

const SID = "ses_edb5b5b8cffeC9yAycV4DZhfig";

interface Fake { child: ChildProcess; stdout: PassThrough; stderr: PassThrough; args: string[]; cwd: string; pid: number }

function harness(opts: { resume?: string } = {}) {
  const spawned: Fake[] = [];
  let pid = 100;
  const spawnFn = (command: string, args: string[], cwd: string): ChildProcess => {
    expect(command).toBe("opencode");
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, pid: ++pid, kill: vi.fn() });
    spawned.push({ child, stdout, stderr, args, cwd, pid });
    return child;
  };
  const outputs: string[] = [];
  const turns: TurnSummary[] = [];
  const exits: (Error | undefined)[] = [];
  const handle = startOpencodeLiveSession(
    { cli: "opencode", projectPath: "/p", prompt: "go", ...(opts.resume ? { resume: opts.resume } : {}) },
    { onOutput: (l) => outputs.push(l), onExit: (e) => exits.push(e), onTurnComplete: (s) => turns.push(s) },
    spawnFn, 60_000, () => 0,
  );
  const last = (): Fake => spawned.at(-1)!;
  const emit = (ev: object, f: Fake = last()): void => { f.stdout.write(JSON.stringify(ev) + "\n"); };
  const close = async (code: number | null, f: Fake = last()): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    f.child.emit("close", code);
  };
  const step = (sid: string, reason: string, parts: object[], f: Fake = last()): void => {
    emit({ type: "step_start", sessionID: sid, part: {} }, f);
    for (const p of parts) emit({ sessionID: sid, ...p }, f);
    emit({ type: "step_finish", sessionID: sid, part: { reason } }, f);
  };
  return { handle, spawned, last, emit, close, step, outputs, turns, exits };
}

let killSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { ps.out = ""; killSpy = vi.spyOn(process, "kill").mockImplementation(() => true); });
afterEach(() => { killPendingGroups(); killSpy.mockRestore(); vi.useRealTimers(); });

describe("startOpencodeLiveSession", () => {
  it("runs fresh then resumes the reported session; a tool step then stop is one completed turn", async () => {
    const h = harness();
    expect(h.spawned[0]!.cwd).toBe("/p");
    const fresh = h.spawned[0]!.args;
    expect(fresh.slice(0, 4)).toEqual(["run", "--auto", "--format", "json"]);
    expect(fresh).not.toContain("--session");
    expect(fresh.at(-2)).toBe("--");
    expect(fresh.at(-1)).toMatch(/^go/);
    expect(fresh.at(-1)).not.toContain("FAILED:");

    h.step(SID, "tool-calls", [{ type: "tool_use", part: { tool: "bash" } }]);
    h.step(SID, "stop", [{ type: "text", part: { text: "done it" } }]);
    await h.close(0);
    expect(h.outputs).toEqual(["▸ bash", "done it"]);
    expect(h.turns).toEqual([{ result: "done it", durationMs: 0 }]);

    h.handle.send("next");
    expect(h.last().args).toEqual(["run", "--auto", "--format", "json", "--session", SID, "--", "next"]);
  });

  it("a 401 error never leaks data.message; it ends turn 1 with the signed-out notice", async () => {
    const h = harness();
    h.emit({ type: "error", sessionID: SID, error: { name: "APIError", data: { statusCode: 401, message: "Incorrect API key provided: sk-abc123 at /Users/x" } } });
    await h.close(1);
    expect(h.exits[0]?.message).toBe(OPENCODE_SIGNED_OUT);
    expect(h.outputs).toEqual([]);
    expect(JSON.stringify(h.exits[0]?.message)).not.toMatch(/sk-|Users/);
  });

  it("a later error without statusCode is a failed turn with the fixed hint; the session stays bound", async () => {
    const h = harness();
    h.step(SID, "stop", [{ type: "text", part: { text: "one" } }]);
    await h.close(0);
    h.handle.send("two");
    h.emit({ type: "error", sessionID: SID, error: { name: "UnknownError", data: { message: "secret sk-xyz" } } });
    await h.close(1);
    expect(h.turns.at(-1)?.failed).toBe("opencode couldn't run that turn (UnknownError) — check the model's provider login on the host (`opencode auth list`).");
    expect(h.exits).toEqual([]);
  });

  it("an error carrying a sessionID doesn't count as started", async () => {
    const h = harness();
    h.emit({ type: "error", sessionID: SID, error: { name: "UnknownError", data: {} } });
    await h.close(1);
    expect(h.turns).toEqual([]);
    expect(h.exits[0]?.message).toMatch(/^opencode couldn't run that turn \(UnknownError\)/);
  });

  it("Session not found on a resume is RESUME_REJECTED; a non-ses_ id is refused before spawn", async () => {
    const h = harness({ resume: SID });
    expect(h.spawned[0]!.args).toContain("--session");
    h.last().stderr.write("Error: Session not found\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.close(1);
    warn.mockRestore();
    expect(h.exits[0]?.message).toBe(RESUME_REJECTED);

    const bad = harness({ resume: "3f2a-uuid" });
    await Promise.resolve();
    expect(bad.spawned).toHaveLength(0);
    expect(bad.exits[0]?.message).toBe(RESUME_REJECTED);
  });

  it("a resume answered from another session is stopped and its output suppressed", async () => {
    const h = harness({ resume: SID });
    h.step("ses_other", "stop", [{ type: "text", part: { text: "hello from elsewhere" } }]);
    await h.close(1);
    expect(h.outputs).toEqual([]);
    expect(h.turns).toEqual([]);
    expect(h.exits[0]?.message).toBe(OPENCODE_SESSION_MISMATCH);
  });

  it("stop reaps the tool groups: SIGTERM to each now, SIGKILL after 5s even once opencode closed", async () => {
    vi.useFakeTimers();
    const h = harness();
    const pid = h.last().pid;
    ps.out = `${pid} 1 ${pid}\n900 ${pid} 900\n`;
    h.handle.stop();
    expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-900, "SIGTERM");
    h.last().child.emit("close", null);
    expect(h.exits).toEqual([undefined]);
    vi.advanceTimersByTime(5_000);
    expect(killSpy).toHaveBeenCalledWith(-900, "SIGKILL");
  });
});
