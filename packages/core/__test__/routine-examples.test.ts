// packages/core/__test__/routine-examples.test.ts
import { describe, expect, it } from "vitest";
import { projectBeanDir, skillsDir } from "../src/config.js";
import { loadSkills } from "../src/skill-library.js";
import { exampleRoutine, ROUTINE_EXAMPLES } from "../src/routine-examples.js";
import { describeRoutineError } from "../src/routine-store.js";
import { runRoutine, type RoutineRunnerDeps } from "../src/routine-runner.js";
import type { CommandStepOutcome } from "../src/command-step.js";
import type { TodoItem } from "../src/todo-store.js";

/** A claim() fake: hands out a copy of `items` front to back. */
const claimFrom = (items: TodoItem[]) => { const q = [...items]; return async () => q.shift(); };

const example = (key: string) => ROUTINE_EXAMPLES.find((e) => e.key === key)!.routine;

describe("routine examples", () => {
  it("each validates, is disabled, and only uses shipped skills", async () => {
    const shipped = new Set((await loadSkills(skillsDir(projectBeanDir()))).map((s) => s.name));
    for (const { key, routine } of ROUTINE_EXAMPLES) {
      expect(describeRoutineError(routine), key).toBeNull();
      expect(routine.enabled, key).toBe(false);
      for (const s of routine.steps) if (s.skill) expect(shipped.has(s.skill), `${key}: ${s.skill}`).toBe(true);
    }
  });

  it("copies under a free name so saving never overwrites an existing routine", () => {
    const ex = ROUTINE_EXAMPLES[0]!;
    const copy = exampleRoutine(ex, [ex.routine.name, `${ex.routine.name}-2`]);
    expect(copy.name).toBe(`${ex.routine.name}-3`);
    copy.steps.pop();
    expect(ex.routine.steps).toHaveLength(4);
  });
});

/** Runs one queued todo through an example; the fakes answer per step id. */
async function run(key: string, answers: { chat?: string[]; delegate?: Record<string, string>; command?: number[] }) {
  const ran: string[] = [];
  const exits = [...(answers.command ?? [0])];
  const todo = { id: "t1", routine: key, text: "Add login\nhttps://github.com/o/r/issues/1", status: "pending", createdAt: "x" } as TodoItem;
  const chats = [...(answers.chat ?? [])];
  const deps: RoutineRunnerDeps = {
    model: "gpt-test", tools: [], now: () => new Date("2026-10-13T06:00:00Z"),
    findSkill: (name) => ({ name, description: "", body: `# ${name}` }) as never,
    // The lint step's answer, then the digest.
    chat: async () => ({ content: chats.shift() ?? "digest", toolCalls: [] }),
    delegate: async (req) => {
      const id = ROUTINE_EXAMPLES.flatMap((e) => e.routine.steps).find((s) => s.kind === "delegate" && req.instruction.startsWith(s.instruction))?.id ?? "?";
      ran.push(id);
      return { output: answers.delegate?.[id] ?? "done", cli: "claude" };
    },
    command: async (): Promise<CommandStepOutcome> => { ran.push("test"); const exitCode = exits.length > 1 ? exits.shift()! : exits[0]!; return { exitCode, output: "" }; },
    todos: { claim: claimFrom([todo]), setStatus: async () => {} },
  };
  const res = await runRoutine({ ...example(key), enabled: true }, deps);
  return { ran, status: res.record.status };
}

describe("example flows run as described", () => {
  it("ticket lint first: a vague ticket stops at lint and runs clarify", async () => {
    const r = await run("ticket-lint-first", { chat: ["Done: missing\nVERDICT: FAIL"] });
    expect(r.ran).toEqual(["clarify"]);
    expect(r.status).toBe("needs-attention");
  });

  it("ticket lint first: a clear ticket reaches pr and skips clarify", async () => {
    const r = await run("ticket-lint-first", { chat: ["all ok\nVERDICT: PASS"] });
    expect(r.ran).toEqual(["implement", "test", "pr"]);
    expect(r.status).toBe("ok");
  });

  it("dev loop: a failing test loops back to implement before passing", async () => {
    const r = await run("dev-loop", { command: [1, 0], delegate: { review: "no findings\nVERDICT: PASS" } });
    expect(r.ran).toEqual(["implement", "test", "implement", "test", "review", "pr"]);
    expect(r.status).toBe("ok");
  });

  it("triage: a bug runs implement → pr and skips answer", async () => {
    const r = await run("triage", { chat: ["Broken login.\nROUTE: bug"] });
    expect(r.ran).toEqual(["implement", "pr"]);
    expect(r.status).toBe("ok");
  });

  it("triage: a question skips implement and pr; anything else ends after triage", async () => {
    expect((await run("triage", { chat: ["How do I log in?\nROUTE: question"] })).ran).toEqual([]);
    expect((await run("triage", { chat: ["Spam.\nROUTE: nothing"] })).status).toBe("ok");
  });

  it("parallel checks: lint, test and review all run before triage; a FAIL triage loops to implement", async () => {
    const pass = await run("parallel-checks", { chat: ["all clean\nVERDICT: PASS"] });
    expect([...pass.ran].sort()).toEqual(["implement", "pr", "review", "test", "test"]);
    expect(pass.ran[0]).toBe("implement");
    expect(pass.ran.at(-1)).toBe("pr");
    expect(pass.status).toBe("ok");
    const loop = await run("parallel-checks", { chat: ["lint errors\nVERDICT: FAIL", "all clean\nVERDICT: PASS"] });
    expect(loop.ran.filter((id) => id === "implement")).toHaveLength(2);
    expect(loop.ran.filter((id) => id === "test")).toHaveLength(4);
    expect(loop.status).toBe("ok");
  });

  it("review only: a FAIL review stops before notify", async () => {
    const r = await run("review-only", { delegate: { review: "[P1] a.ts:1 — bug\nVERDICT: FAIL" } });
    expect(r.ran).toEqual(["review"]);
    expect(r.status).toBe("needs-attention");
  });
});
