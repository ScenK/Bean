import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_QUEUE_LIMIT, CODEX_SIGNED_OUT, CODEX_THREAD_MISMATCH, startCodexLiveSession,
} from "../src/codex-live-session.js";
import { RESUME_REJECTED, type TurnSummary } from "../src/live-session.js";

const TID = "019a6b1e-7c3d-7f00-9a1b-2c3d4e5f6a7b";

interface Fake { child: ChildProcess; stdout: PassThrough; stderr: PassThrough; args: string[]; pid: number }

function harness(opts: { resume?: string; idleMs?: number } = {}) {
  const spawned: Fake[] = [];
  let pid = 100;
  const spawnFn = (command: string, args: string[]): ChildProcess => {
    expect(command).toBe("codex");
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, pid: ++pid, kill: vi.fn() });
    spawned.push({ child, stdout, stderr, args, pid });
    return child;
  };
  const outputs: string[] = [];
  const turns: TurnSummary[] = [];
  const exits: (Error | undefined)[] = [];
  let clock = 0;
  const handle = startCodexLiveSession(
    { cli: "codex", projectPath: "/p", prompt: "go", ...(opts.resume ? { resume: opts.resume } : {}) },
    { onOutput: (l) => outputs.push(l), onTurnComplete: (s) => turns.push(s), onExit: (e) => exits.push(e) },
    spawnFn, opts.idleMs ?? 60_000, () => clock,
  );
  const last = (): Fake => spawned.at(-1)!;
  const emit = (ev: object, f: Fake = last()): void => { f.stdout.write(JSON.stringify(ev) + "\n"); };
  const close = async (code: number | null, f: Fake = last()): Promise<void> => {
    await new Promise((r) => setImmediate(r)); // let stream data land before close
    f.child.emit("close", code);
  };
  const completeTurn = async (text: string, f: Fake = last(), tid = TID): Promise<void> => {
    emit({ type: "thread.started", thread_id: tid }, f);
    emit({ type: "turn.started" }, f);
    emit({ type: "item.completed", item: { type: "agent_message", text } }, f);
    emit({ type: "turn.completed", usage: {} }, f);
    clock += 6100;
    await close(0, f);
  };
  return { handle, spawned, last, emit, close, completeTurn, outputs, turns, exits };
}

let killSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { killSpy = vi.spyOn(process, "kill").mockImplementation(() => true); });
afterEach(() => { killSpy.mockRestore(); vi.useRealTimers(); });

describe("startCodexLiveSession", () => {
  it("runs a fresh turn, then resumes the emitted thread — `--` before the prompt, no FAILED sentinel", async () => {
    const h = harness();
    expect(h.spawned[0]!.args.slice(0, 4)).toEqual(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]);
    expect(h.spawned[0]!.args.at(-2)).toBe("--");
    expect(h.spawned[0]!.args.at(-1)).toContain("Co-Authored-By: Bean");
    expect(h.spawned[0]!.args.at(-1)).not.toContain("FAILED:");
    await h.completeTurn("found it");
    expect(h.turns).toEqual([{ result: "found it", durationMs: 6100 }]);
    expect(h.handle.send("next")).toBe(true);
    expect(h.spawned[1]!.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(h.spawned[1]!.args.slice(-3)).toEqual(["--", TID, "next"]);
  });

  it("renders a shell command as `▸ shell`, never the raw command", async () => {
    const h = harness();
    h.emit({ type: "thread.started", thread_id: TID });
    h.emit({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cat /Users/x/secret'" } });
    h.emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
    await new Promise((r) => setImmediate(r));
    expect(h.outputs).toEqual(["▸ shell", "done"]);
  });

  it("merges messages sent mid-turn into one next turn, spawned only after close, and refuses overflow", async () => {
    const h = harness();
    expect(h.handle.send("a")).toBe(true);
    expect(h.handle.send("b")).toBe(true);
    expect(h.handle.send("x".repeat(CODEX_QUEUE_LIMIT))).toBe(false);
    expect(h.spawned).toHaveLength(1);
    expect(h.handle.pid).toBe(h.spawned[0]!.pid);
    await h.completeTurn("one");
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1]!.args.at(-1)).toBe("a\n\nb");
    expect(h.handle.pid).toBe(h.spawned[1]!.pid);
  });

  it("stop mid-turn SIGINTs the group, then SIGKILLs after 5s; no turn footer, clean exit after close", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit({ type: "thread.started", thread_id: TID });
    h.handle.send("queued");
    h.handle.stop();
    expect(killSpy).toHaveBeenCalledWith(-h.spawned[0]!.pid, "SIGINT");
    vi.advanceTimersByTime(5_000);
    expect(killSpy).toHaveBeenCalledWith(-h.spawned[0]!.pid, "SIGKILL");
    h.spawned[0]!.child.emit("close", 1);
    expect(h.turns).toEqual([]);
    expect(h.exits).toEqual([undefined]);
    expect(h.spawned).toHaveLength(1); // the queued text was dropped
  });

  it("stop between turns ends at once; idle expiry ends it too", async () => {
    const h = harness();
    await h.completeTurn("one");
    h.handle.stop();
    expect(h.exits).toEqual([undefined]);

    vi.useFakeTimers();
    const idle = harness({ idleMs: 1_000 });
    idle.emit({ type: "thread.started", thread_id: TID });
    idle.emit({ type: "turn.completed" });
    await vi.advanceTimersByTimeAsync(0);
    idle.last().child.emit("close", 0);
    vi.advanceTimersByTime(1_000);
    expect(idle.exits).toEqual([undefined]);
  });

  it("a fresh turn 1 that dies before thread.started ends the session; a later failure stays bound", async () => {
    const dead = harness();
    dead.last().stderr.write("boom\n");
    await dead.close(1);
    expect(dead.exits[0]?.message).toContain("codex exited with code 1");

    const h = harness();
    await h.completeTurn("one");
    h.handle.send("two");
    h.emit({ type: "thread.started", thread_id: TID });
    h.emit({ type: "turn.failed", error: { message: "model overloaded" } });
    await h.close(1);
    expect(h.turns.at(-1)).toMatchObject({ result: "", failed: "model overloaded" });
    expect(h.exits).toEqual([]);
    expect(h.handle.send("three")).toBe(true);
    expect(h.spawned).toHaveLength(3);
  });

  it("an auth failure renders the signed-out message", async () => {
    const h = harness();
    h.last().stderr.write("Error: 401 Unauthorized\n");
    await h.close(1);
    expect(h.exits[0]?.message).toBe(CODEX_SIGNED_OUT);
  });

  it("a resumed turn 1 with no rollout is RESUME_REJECTED, never a fresh session", async () => {
    const h = harness({ resume: TID });
    expect(h.spawned[0]!.args.slice(-3, -1)).toEqual(["--", TID]);
    h.last().stderr.write(`thread/resume failed: no rollout found for thread id ${TID}\n`);
    await h.close(1);
    expect(h.exits[0]?.message).toBe(RESUME_REJECTED);
    expect(h.spawned).toHaveLength(1);
  });

  it("a resume that emits a different thread is stopped, its output suppressed", async () => {
    const h = harness({ resume: TID });
    h.emit({ type: "thread.started", thread_id: "019a0000-0000-7000-8000-000000000000" });
    h.emit({ type: "item.completed", item: { type: "agent_message", text: "hello from a new thread" } });
    await new Promise((r) => setImmediate(r));
    expect(killSpy).toHaveBeenCalledWith(-h.spawned[0]!.pid, "SIGINT");
    await h.close(1);
    expect(h.outputs).toEqual([]);
    expect(h.turns).toEqual([]);
    expect(h.exits[0]?.message).toBe(CODEX_THREAD_MISMATCH);
  });

  it("refuses a non-UUID resume id before spawning", async () => {
    const h = harness({ resume: "my-thread-name" });
    await Promise.resolve();
    expect(h.spawned).toHaveLength(0);
    expect(h.exits[0]?.message).toBe(RESUME_REJECTED);
  });
});
