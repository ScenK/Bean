import { describe, expect, it } from "vitest";
import type { RoutineStep } from "@bean/core";
import { stepEdgeProblems } from "@bean/core/routine-graph";
import { duplicateStep, remapStepMissing, setStepNext, stepProblemsText, withStepIds } from "../src/renderer/components/routines/step-ids.js";

describe("withStepIds", () => {
  it("assigns <skill>-<n>/<kind>-<n> to id-less steps and keeps existing ids through reorder/delete", () => {
    const steps = withStepIds([
      { kind: "delegate", skill: "Code Review", instruction: "a" },
      { kind: "delegate", skill: "code-review", instruction: "b" },
      { kind: "chat", instruction: "c" },
    ]);
    expect(steps.map((s) => s.id)).toEqual(["code-review-1", "code-review-2", "chat-1"]);
    const reordered = withStepIds([steps[2]!, steps[0]!]);
    expect(reordered.map((s) => s.id)).toEqual(["chat-1", "code-review-1"]);
    const added = withStepIds([...reordered, { kind: "delegate", skill: "code-review", instruction: "d" }]);
    expect(added.map((s) => s.id)).toEqual(["chat-1", "code-review-1", "code-review-2"]);
  });

  it("flags a pinned harness this Mac can't run", () => {
    const steps: RoutineStep[] = [
      { kind: "delegate", skill: "s", cli: "codex", instruction: "x" },
      { kind: "chat", instruction: "y" },
    ];
    expect(stepProblemsText(steps, ["claude"], [])).toBe("step 1: codex is not enabled");
    expect(stepProblemsText(steps, ["codex"], [])).toBe("");
  });
});

describe("duplicateStep", () => {
  const steps: RoutineStep[] = [
    { id: "impl", kind: "delegate", skill: "code", instruction: "implement", timeoutMinutes: 30, next: "ship" },
    { id: "review", kind: "chat", instruction: "review", gate: { onFail: { goto: "impl", maxRounds: 2 } } },
    { id: "ship", kind: "chat", instruction: "ship", gate: { onFail: { goto: "end-1" } } },
    { id: "end-1", kind: "chat", instruction: "end" },
  ];

  it("inserts an exact deep copy below with a fresh id and no edge problems", () => {
    for (let i = 0; i < steps.length; i++) {
      const out = duplicateStep(steps, i);
      expect(out).toHaveLength(steps.length + 1);
      const { id, ...copy } = out[i + 1]!;
      const { id: origId, ...orig } = steps[i]!;
      expect(copy).toEqual(orig);
      expect(id).not.toBe(origId);
      expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
      expect(stepEdgeProblems(out)).toEqual(out.map(() => null));
    }
    const out = duplicateStep(steps, 1);
    (out[2]!.gate!.onFail as { goto: string }).goto = "ship";
    expect(steps[1]!.gate).toEqual({ onFail: { goto: "impl", maxRounds: 2 } });
    expect(out[1]).toBe(steps[1]);
  });

  it("works on legacy id-less steps and twice in a row", () => {
    const once = duplicateStep([{ kind: "chat", instruction: "a" }, { kind: "chat", instruction: "b" }], 0);
    expect(once.map((s) => s.id)).toEqual(["chat-1", "chat-3", "chat-2"]);
    const twice = duplicateStep(once, 0);
    expect(twice.map((s) => s.id)).toEqual(["chat-1", "chat-4", "chat-3", "chat-2"]);
  });
});

describe("remapStepMissing", () => {
  const steps = withStepIds(Array.from({ length: 11 }, (_, i) => ({ kind: "chat" as const, instruction: `s${i}` })));
  const q = (field: string) => ({ field, question: field });

  it("moves questions with their step on reorder and drops them on remove", () => {
    const missing = [q("steps.0.project"), q("steps.2"), q("cron")];
    const reordered = [steps[2]!, steps[0]!, steps[1]!];
    expect(remapStepMissing(missing, steps.slice(0, 3), reordered).map((m) => m.field)).toEqual(["steps.1.project", "steps.0", "cron"]);
    const removed = [steps[1]!, steps[2]!];
    expect(remapStepMissing(missing, steps.slice(0, 3), removed).map((m) => m.field)).toEqual(["steps.1", "cron"]);
  });

  it("keeps the original's question on duplicate, none on the copy; an edit answers it", () => {
    const before = steps.slice(0, 2);
    const after = duplicateStep(before, 0);
    expect(remapStepMissing([q("steps.0"), q("steps.1")], before, after).map((m) => m.field)).toEqual(["steps.0", "steps.2"]);
    const edited = [{ ...before[0]!, instruction: "changed" }, before[1]!];
    expect(remapStepMissing([q("steps.0"), q("steps.1")], before, edited).map((m) => m.field)).toEqual(["steps.1"]);
  });

  it("keeps steps.1 and steps.10 apart and drops out-of-range indexes", () => {
    const after = [steps[10]!, ...steps.slice(0, 10)];
    expect(remapStepMissing([q("steps.1"), q("steps.10"), q("steps.99"), q("sinks")], steps, after).map((m) => m.field))
      .toEqual(["steps.2", "steps.0", "sinks"]);
  });

  it("uses the first index for a duplicated id", () => {
    const dup = [steps[0]!, { ...steps[0]! }];
    expect(remapStepMissing([q("steps.1")], dup, [steps[1]!, ...dup]).map((m) => m.field)).toEqual(["steps.1"]);
  });
});

describe("setStepNext", () => {
  const steps: RoutineStep[] = [
    { kind: "chat", instruction: "a" },
    { kind: "chat", instruction: "b" },
    { kind: "chat", instruction: "c" },
  ];

  it("points next at a later step by id, at end, or clears it", () => {
    const toLast = setStepNext(steps, 0, 2);
    expect(toLast[0]!.next).toBe("chat-3");
    expect(stepEdgeProblems(toLast)).toEqual([null, null, null]);
    expect(setStepNext(toLast, 0, "end")[0]!.next).toBe("end");
    expect("next" in setStepNext(toLast, 0, undefined)[0]!).toBe(false);
  });

  it("a reorder that makes next point backward shows the inline problem", () => {
    const [a, b, c] = setStepNext(steps, 0, 2);
    expect(stepEdgeProblems([c!, a!, b!])[1]).toMatch(/later step/);
  });
});
