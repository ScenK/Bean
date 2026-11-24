import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGY_CONVERSATION_MISMATCH, startAgyLiveSession } from "../src/agy-live-session.js";
import { AGY_SIGNED_OUT } from "../src/delegate.js";
import { killPendingGroups } from "../src/kill-tree.js";
import { withCliRules } from "../src/agent-rules.js";
import { RESUME_REJECTED, type TurnSummary } from "../src/live-session.js";
import { startLiveEngine } from "../src/chatops/live-sessions.js";
import { isLiveSessionId } from "../src/delegate-runs.js";

// killTree's `ps` snapshot (kill-tree.ts): no descendants.
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: () => "" }));

const CONV = "c90b8b9c-97a9-44cb-a2cf-cf0e28b56144";
const OTHER = "11111111-2222-3333-4444-555555555555";

interface Fake { child: ChildProcess; stdout: PassThrough; stderr: PassThrough; command: string; args: string[]; pid: number }

function harness(opts: { resume?: string; prompt?: string } = {}) {
  const spawned: Fake[] = [];
  let pid = 100;
  const spawnFn = (command: string, args: string[]): ChildProcess => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, pid: ++pid, kill: vi.fn() });
    spawned.push({ child, stdout, stderr, command, args, pid });
    return child;
  };
  const outputs: string[] = [];
  const texts: string[] = [];
  const turns: TurnSummary[] = [];
  const exits: (Error | undefined)[] = [];
  const ids: string[] = [];
  const handle = startAgyLiveSession(
    { cli: "agy", projectPath: "/p", prompt: opts.prompt ?? "go", ...(opts.resume ? { resume: opts.resume } : {}) },
    { onOutput: (l) => outputs.push(l), onText: (t) => texts.push(t), onExit: (e) => exits.push(e), onSessionId: (id) => ids.push(id), onTurnComplete: (s) => turns.push(s) },
    spawnFn, 60_000, () => 0,
  );
  const last = (): Fake => spawned.at(-1)!;
  const emit = (ev: object, f: Fake = last()): void => { f.stdout.write(JSON.stringify(ev) + "\n"); };
  const step = (s: Record<string, unknown>, f?: Fake): void => emit({ event: "step_update", step_update: { conversation_id: CONV, ...s } }, f);
  const close = async (code: number | null, f: Fake = last()): Promise<void> => {
    await new Promise((r) => setImmediate(r)); // let stream data land before close
    f.child.emit("close", code);
  };
  return { handle, spawned, last, emit, step, close, outputs, texts, turns, exits, ids };
}

let killSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { killSpy = vi.spyOn(process, "kill").mockImplementation(() => true); });
afterEach(() => { killPendingGroups(); killSpy.mockRestore(); });

describe("startAgyLiveSession", () => {
  it("streams deltas as one text per agent_response step, tools as ▸ <tool_name>, and resumes the conversation next turn", async () => {
    const h = harness();
    expect(h.last().command).toBe("agy");
    expect(h.last().args).toEqual([`-p=${withCliRules("go", "live")}`, "--output-format", "stream-json", "--dangerously-skip-permissions"]);
    h.emit({ event: "init", conversation_id: CONV });
    h.step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Look" });
    h.step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ing." });
    h.step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls ~" } } });
    h.step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command" });
    h.step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Do" });
    h.step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "ne.\n" });
    h.emit({ event: "result", result: { conversation_id: CONV, status: "SUCCESS", response: "Done.\n" } });
    await h.close(0);
    expect(h.texts).toEqual(["Looking.", "Done."]);
    expect(h.outputs).toEqual(["Looking.", "▸ run_command", "Done."]);
    expect(h.outputs.join("")).not.toContain("ls ~");
    expect(h.ids).toEqual([CONV]);
    expect(h.turns).toEqual([{ result: "Done.\n", durationMs: 0 }]);

    h.handle.send("more");
    expect(h.spawned).toHaveLength(2);
    expect(h.last().args).toEqual(["-p=more", "--output-format", "stream-json", "--dangerously-skip-permissions", "--conversation", CONV]);
  });

  it("an unfinished step's deltas don't leak into the next turn", async () => {
    const h = harness();
    h.emit({ event: "init", conversation_id: CONV });
    h.step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "half" });
    expect(h.handle.interrupt()).toBe(true);
    await h.close(null);
    expect(h.turns).toEqual([{ result: "", durationMs: 0, interrupted: true }]);
    h.handle.send("again");
    h.emit({ event: "init", conversation_id: CONV });
    h.step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "fresh" });
    h.emit({ event: "result", result: { conversation_id: CONV, status: "SUCCESS", response: "fresh" } });
    await h.close(0);
    expect(h.texts).toEqual(["fresh"]);
  });

  it("stop SIGTERMs every group of agy's tree, then SIGKILLs after 5s", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.emit({ event: "init", conversation_id: CONV });
      h.handle.stop();
      expect(killSpy).toHaveBeenCalledWith(-h.spawned[0]!.pid, "SIGTERM");
      vi.advanceTimersByTime(5_000);
      expect(killSpy).toHaveBeenCalledWith(-h.spawned[0]!.pid, "SIGKILL");
    } finally { vi.useRealTimers(); }
  });

  it("continuing an id agy no longer has stops at init with the mismatch message and shows none of the fresh output", async () => {
    const h = harness({ resume: OTHER, prompt: "" });
    h.handle.send("hi");
    expect(h.last().args).toContain(OTHER);
    h.emit({ event: "init", conversation_id: CONV });
    expect(killSpy).toHaveBeenCalledWith(-h.spawned[0]!.pid, "SIGTERM");
    h.step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "fresh answer" });
    h.emit({ event: "result", result: { conversation_id: CONV, status: "SUCCESS", response: "fresh answer" } });
    await h.close(0);
    expect(h.texts).toEqual([]);
    expect(h.outputs).toEqual([]);
    expect(h.ids).toEqual([]);
    expect(h.exits.map((e) => e?.message)).toEqual([AGY_CONVERSATION_MISMATCH]);
  });

  it("a non-UUID resume id is rejected without a spawn", async () => {
    const h = harness({ resume: "ses_abc" });
    await new Promise((r) => setImmediate(r));
    expect(h.spawned).toHaveLength(0);
    expect(h.exits.map((e) => e?.message)).toEqual([RESUME_REJECTED]);
  });

  it("signed out: the signed-out message, never the stderr's login URL", async () => {
    const h = harness();
    h.last().stderr.write("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=1\nerror: authentication failed or timed out\n");
    h.emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out" } });
    await h.close(1);
    expect(h.exits.map((e) => e?.message)).toEqual([AGY_SIGNED_OUT]);
  });

  it("a mid-session ERROR result fails the turn with agy's error and keeps the session", async () => {
    const h = harness();
    h.emit({ event: "init", conversation_id: CONV });
    h.emit({ event: "result", result: { conversation_id: CONV, status: "ERROR", response: "", error: "quota exceeded" } });
    await h.close(1);
    expect(h.turns).toEqual([{ result: "", durationMs: 0, failed: "quota exceeded" }]);
    expect(h.exits).toEqual([]);
  });
});

it("startLiveEngine runs agy on the per-turn engine; agy live ids are UUIDs", () => {
  const spawnFn = vi.fn((_c: string, _a: string[]) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: 7, kill: vi.fn() });
    return child;
  });
  const handle = startLiveEngine({ cli: "agy", projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onExit: () => {}, onTurnComplete: () => {} }, spawnFn);
  expect(spawnFn.mock.calls[0]?.[0]).toBe("agy");
  handle.stop();
  expect(isLiveSessionId("agy", CONV)).toBe(true);
  expect(isLiveSessionId("agy", "ses_abc")).toBe(false);
});
