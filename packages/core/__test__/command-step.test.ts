// packages/core/__test__/command-step.test.ts
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { killAllCommands, runShellCommand } from "../src/command-step.js";
import { runRoutine, type CommandStepRequest, type RoutineRunnerDeps } from "../src/routine-runner.js";
import { describeRoutineError, type Routine, type RoutineStep } from "../src/routine-store.js";
import type { CommandStepOutcome, StepAttempt, TodoItem } from "../src/index.js";

/** A claim() fake: hands out a copy of `items` front to back. */
const claimFrom = (items: TodoItem[]) => { const q = [...items]; return async () => q.shift(); };

const routine = (steps: RoutineStep[], over: Partial<Routine> = {}): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {}, ...over });

const err = (step: object): string | null =>
  describeRoutineError({ name: "r", enabled: true, cron: "0 6 * * *", steps: [step], sinks: {} });

describe("command step validation", () => {
  it("accepts a non-empty command, with optional project and timeout", () => {
    expect(err({ kind: "command", id: "test", command: "pnpm test", project: "/p", timeoutMinutes: 20 })).toBeNull();
  });

  it("rejects an empty command and any model-ish field", () => {
    expect(err({ kind: "command", command: "  " })).toMatch(/needs a command/);
    expect(err({ kind: "command" })).toMatch(/needs a command/);
    for (const k of ["skill", "model", "cli", "instruction"]) {
      expect(err({ kind: "command", command: "true", [k]: "x" })).toMatch(new RegExp(`remove its ${k}`));
    }
    expect(err({ kind: "command", command: "true", timeoutMinutes: 0 })).toMatch(/timeout/);
  });
});

describe("runShellCommand", () => {
  const opts = { cwd: tmpdir(), env: process.env, timeoutMs: 10_000 };

  it("reports exit code and combined stdout/stderr", async () => {
    expect(await runShellCommand("echo hi", opts)).toEqual({ exitCode: 0, output: "hi\n" });
    const res = await runShellCommand("echo out; echo err 1>&2; exit 3", opts);
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain("out\n");
    expect(res.output).toContain("err\n");
  });

  it("caps output to the tail", async () => {
    const res = await runShellCommand("head -c 50000 /dev/zero | tr '\\0' a; echo END", opts);
    expect(res.output.length).toBeLessThanOrEqual(16_000);
    expect(res.output.endsWith("END\n")).toBe(true);
  });

  it("times out by killing the whole process group (a background child can't hold it open)", async () => {
    const started = Date.now();
    await expect(runShellCommand("sleep 30 & wait", { ...opts, timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("killAllCommands stops a running command's whole group (app quit)", async () => {
    const started = Date.now();
    const run = runShellCommand("sleep 30 & wait", opts);
    await new Promise((r) => setTimeout(r, 100));
    killAllCommands();
    await run; // the backgrounded `sleep 30` died too, or this would take 30s
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("command steps in a run", () => {
  const baseDeps = (command: RoutineRunnerDeps["command"], over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps => ({
    chat: async () => ({ content: "digest", toolCalls: [] }), model: "gpt-test",
    delegate: async (req) => ({ output: `did: ${req.instruction}`, cli: "claude" }), tools: [],
    findSkill: () => undefined, command, ...over,
  });
  const fixed = (...outcomes: CommandStepOutcome[]) => {
    const calls: CommandStepRequest[] = [];
    const command = async (req: CommandStepRequest): Promise<CommandStepOutcome> => {
      calls.push(req);
      return outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
    };
    return { command, calls };
  };

  it("exit 0 is PASS; no model, memories, or skill involved", async () => {
    const f = fixed({ exitCode: 0, output: "all green\n" });
    let memoriesLoaded = false;
    const attempts: StepAttempt[] = [];
    const res = await runRoutine(routine([{ kind: "command", id: "test", command: "pnpm test", project: "/p" }]), baseDeps(f.command, {
      memories: async () => { memoriesLoaded = true; return []; }, recordAttempt: (a) => attempts.push(a),
    }));
    expect(f.calls).toEqual([{ command: "pnpm test", projectPath: "/p", env: {} }]);
    expect(memoriesLoaded).toBe(false);
    expect(res.record.status).toBe("ok");
    expect(res.record.steps[0]).toMatchObject({ kind: "command", id: "test", verdict: "PASS", ok: true });
    expect(attempts[0]).toMatchObject({ kind: "command", verdict: "PASS", ok: true, output: "all green\n(exit 0)" });
    expect(attempts[0]?.model).toBeUndefined();
  });

  it("ungated non-zero exit fails the step; a timeout is a step error", async () => {
    const res = await runRoutine(routine([{ kind: "command", command: "false" }]), baseDeps(fixed({ exitCode: 1, output: "boom" }).command));
    expect(res.record.status).toBe("failed");
    expect(res.record.steps[0]).toMatchObject({ verdict: "FAIL", ok: false });

    const timedOut = await runRoutine(routine([{ kind: "command", command: "sleep 99" }]),
      baseDeps(async () => { throw new Error("command timed out after 1 minutes"); }));
    expect(timedOut.record.steps[0]).toMatchObject({ ok: false, summary: "command timed out after 1 minutes" });
    expect(timedOut.record.status).toBe("failed");
  });

  it("a gated failing command loops back with its output tail as feedback", async () => {
    const f = fixed({ exitCode: 1, output: "FAIL src/a.test.ts > adds\n" }, { exitCode: 0, output: "ok" });
    const instructions: string[] = [];
    const res = await runRoutine(routine([
      { kind: "delegate", id: "implement", skill: "s", instruction: "implement it" },
      { kind: "command", id: "test", command: "pnpm test", gate: { onFail: { goto: "implement", maxRounds: 3 } } },
    ]), baseDeps(f.command, {
      findSkill: () => ({ name: "s", description: "", body: "b" }) as never,
      delegate: async (req) => { instructions.push(req.instruction); return { output: "done", cli: "claude" }; },
    }));
    expect(f.calls).toHaveLength(2);
    expect(instructions).toHaveLength(2);
    expect(instructions[1]).toContain('The check at step "test" failed');
    expect(instructions[1]).toContain("FAIL src/a.test.ts > adds");
    expect(instructions[1]).toContain("(exit 1)");
    expect(res.record.status).toBe("ok");
    expect(res.record.steps.map((s) => s.verdict)).toEqual([undefined, "FAIL", undefined, "PASS"]);
  });

  it("todo-driven runs get BEAN_TODO_ID / BEAN_TODO_TEXT", async () => {
    const f = fixed({ exitCode: 0, output: "" });
    const todo: TodoItem = { id: "t1", routine: "r", text: "PROJ-1 add login", status: "pending", createdAt: "x" } as TodoItem;
    await runRoutine(routine([{ kind: "command", command: "./lint-ticket.sh" }], { todoDriven: true }), baseDeps(f.command, {
      todos: { claim: claimFrom([todo]), setStatus: async () => {} },
    }));
    expect(f.calls[0]?.env).toEqual({ BEAN_TODO_ID: "t1", BEAN_TODO_TEXT: "PROJ-1 add login" });
    expect(f.calls[0]?.todoId).toBeUndefined(); // not watch-fired: shared scratch dir, like a delegate
  });

  it("without a command adapter the step fails loudly", async () => {
    const res = await runRoutine(routine([{ kind: "command", command: "true" }]), baseDeps(undefined));
    expect(res.record.steps[0]).toMatchObject({ ok: false, summary: "command steps can't run here" });
  });
});
