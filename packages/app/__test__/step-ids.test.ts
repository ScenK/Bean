import { describe, expect, it } from "vitest";
import type { RoutineStep } from "@bean/core";
import { stepProblemsText, withStepIds } from "../src/renderer/components/routines/step-ids.js";

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
