// packages/core/__test__/routine-runner.test.ts
import { describe, expect, it, vi } from "vitest";
import { runRoutine, type RoutineRunnerDeps } from "../src/routine-runner.js";
import type { Routine } from "../src/routine-store.js";
import type { ActionTool, ConvoMsg, ToolSpec } from "../src/converse.js";
import type { Skill } from "../src/types.js";

const skill = (name: string, target: "chat" | "terminal" = "terminal"): Skill =>
  ({ name, description: `${name} desc`, body: `# ${name} instructions`, target });

const routine = (steps: Routine["steps"]): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {} });

// deps.chat that returns canned replies in order; records every call.
function chatStub(replies: { content: string; toolCalls?: { id?: string; name: string; args: unknown }[] }[]) {
  const calls: { messages: ConvoMsg[]; tools: ToolSpec[] }[] = [];
  const fn: RoutineRunnerDeps["chat"] = async (a) => {
    calls.push({ messages: a.messages, tools: a.tools });
    const next = replies.shift();
    if (!next) throw new Error("chatStub exhausted");
    return { content: next.content, toolCalls: next.toolCalls ?? [] };
  };
  return { fn, calls };
}

const baseDeps = (chat: RoutineRunnerDeps["chat"], over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps => ({
  chat, model: "gpt-test", delegate: async () => "delegate result", tools: [],
  findSkill: () => undefined, now: () => new Date("2026-07-12T06:30:00Z"), ...over,
});

describe("runRoutine", () => {
  it("runs steps in order and threads prior outputs into later steps", async () => {
    const { fn, calls } = chatStub([
      { content: "chat step output" },
      { content: "the digest" }, // digest pass
    ]);
    const delegate = vi.fn(async () => "ci looked fine");
    const res = await runRoutine(
      routine([
        { kind: "delegate", skill: "ci-triage", project: "/p", instruction: "check CI" },
        { kind: "chat", instruction: "summarize mentions" },
      ]),
      baseDeps(fn, { delegate, findSkill: (n) => (n === "ci-triage" ? skill("ci-triage") : undefined) }),
    );
    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "/p", instruction: "check CI", priorOutputs: "",
    }));
    // The chat step's system prompt carries step 1's output.
    const chatSystem = (calls[0]!.messages[0] as { content: string }).content;
    expect(chatSystem).toContain("ci looked fine");
    expect(res.results.map((r) => r.ok)).toEqual([true, true]);
    expect(res.digest).toBe("the digest");
    expect(res.record.status).toBe("ok");
    expect(res.record.steps).toHaveLength(2);
  });

  it("continues past a failed step and marks the run failed", async () => {
    const { fn } = chatStub([{ content: "still ran" }, { content: "digest with failure" }]);
    const res = await runRoutine(
      routine([
        { kind: "delegate", skill: "ci-triage", instruction: "check CI" },
        { kind: "chat", instruction: "sweep" },
      ]),
      baseDeps(fn, {
        delegate: async () => { throw new Error("claude exited with code 1"); },
        findSkill: () => skill("ci-triage"),
      }),
    );
    expect(res.results[0]).toMatchObject({ ok: false });
    expect(res.results[0]!.output).toContain("claude exited with code 1");
    expect(res.results[1]).toMatchObject({ ok: true, output: "still ran" });
    expect(res.record.status).toBe("failed");
  });

  it("chat steps execute action tools and never see propose_* tools", async () => {
    const ran: unknown[] = [];
    const noteTool: ActionTool = {
      spec: { name: "save_note", description: "save", parameters: { type: "object", properties: {} } },
      run: async (args) => { ran.push(args); return "note saved"; },
    };
    const { fn, calls } = chatStub([
      { content: "", toolCalls: [{ id: "t1", name: "save_note", args: { title: "x" } }] },
      { content: "saved it" },
      { content: "digest" },
    ]);
    const res = await runRoutine(
      routine([{ kind: "chat", instruction: "save a note" }]),
      baseDeps(fn, { tools: [noteTool] }),
    );
    expect(ran).toEqual([{ title: "x" }]);
    expect(calls[0]!.tools.map((t) => t.name)).toEqual(["save_note"]);
    expect(res.results[0]!.output).toBe("saved it");
  });

  it("chat step uses the skill body when the step names a skill", async () => {
    const { fn, calls } = chatStub([{ content: "out" }, { content: "digest" }]);
    await runRoutine(
      routine([{ kind: "chat", skill: "inbox", instruction: "sweep" }]),
      baseDeps(fn, { findSkill: (n) => (n === "inbox" ? skill("inbox", "chat") : undefined) }),
    );
    expect((calls[0]!.messages[0] as { content: string }).content).toContain("# inbox instructions");
  });

  it("times out a hung chat step and moves on", async () => {
    vi.useFakeTimers();
    const hung: RoutineRunnerDeps["chat"] = (a) =>
      a.messages.some((m) => m.role === "system" && m.content.includes("Compose one digest"))
        ? Promise.resolve({ content: "digest", toolCalls: [] })
        : new Promise(() => {}); // step call never resolves
    const p = runRoutine(routine([{ kind: "chat", instruction: "hang" }]), baseDeps(hung, { stepTimeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1001);
    const res = await p;
    vi.useRealTimers();
    expect(res.results[0]!.ok).toBe(false);
    expect(res.results[0]!.output).toContain("timed out");
  });

  it("falls back to a plain-text digest when the digest chat call fails", async () => {
    let call = 0;
    const flaky: RoutineRunnerDeps["chat"] = async () => {
      call++;
      if (call === 1) return { content: "step out", toolCalls: [] };
      throw new Error("model down");
    };
    const res = await runRoutine(routine([{ kind: "chat", instruction: "x" }]), baseDeps(flaky));
    expect(res.digest).toContain("step out");
    expect(res.digest).toContain("r"); // routine name present
  });
});
