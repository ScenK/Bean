// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { RoutineStep } from "@bean/core";
import { stepFlow } from "@bean/core/routine-graph";
import { layoutStepFlow } from "../src/renderer/shared/step-flow-layout.js";
import { StepFlow } from "../src/renderer/shared/StepFlow.js";

const s = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep => ({ kind: "chat", id, instruction: "x", ...extra } as RoutineStep);
// classify → bug | spec | reply, rejoining at report; report loops back to classify on fail.
const triage = (): RoutineStep[] => [
  s("classify", { route: { paths: [{ when: "bug", goto: "bug" }, { when: "spec", goto: "spec" }, { when: "reply", goto: "reply" }] } }),
  s("bug", { next: "report" }),
  s("spec", { next: "report" }),
  s("reply"),
  s("report", { gate: { onFail: { goto: "classify", maxRounds: 2 } } }),
];

afterEach(() => { document.body.innerHTML = ""; });

describe("layoutStepFlow", () => {
  it("is deterministic", () => {
    expect(layoutStepFlow(stepFlow(triage()))).toEqual(layoutStepFlow(stepFlow(triage())));
  });

  it("puts sibling paths side by side and the rejoin below every path that reaches it", () => {
    const { boxes } = layoutStepFlow(stepFlow(triage()));
    expect(boxes.map((b) => [b.row, b.col])).toEqual([[0, 0], [1, 0], [1, 1], [1, 2], [2, 0]]);
    for (const p of [1, 2, 3]) expect(boxes[4]!.y).toBeGreaterThan(boxes[p]!.y);
  });

  it("drops a step under a longer path into it, and an unreached step below the last row", () => {
    // 1 → 3 directly and via 2: 3 sits under 2. 4 is skipped by 3's next: end.
    const steps = [s("a", { gate: { onFail: { goto: "c" } } }), s("b"), s("c", { next: "end" }), s("d")];
    expect(layoutStepFlow(stepFlow(steps)).boxes.map((b) => b.row)).toEqual([0, 1, 2, 3]);
  });

  it("routes a loop through the left gutter, left of every box", () => {
    const { boxes, edges } = layoutStepFlow(stepFlow(triage()));
    const loop = edges.find((e) => e.edge.kind === "loop")!;
    const lane = Number(/H([\d.]+)/.exec(loop.d)![1]);
    expect(lane).toBeLessThan(Math.min(...boxes.map((b) => b.x)));
    expect(loop.x).toBeLessThan(Math.min(...boxes.map((b) => b.x)));
  });
});

describe("StepFlow", () => {
  const mount = (steps: RoutineStep[]): HTMLElement => {
    const root = document.createElement("div");
    document.body.append(root);
    act(() => render(h(StepFlow, { steps }), root));
    return root;
  };

  it("renders hostile step text only as text nodes", () => {
    const evil = `<script>alert(1)</script>"><svg onload=alert(2)>`;
    const root = mount([
      { kind: "delegate", id: "a", skill: evil, instruction: evil },
      { kind: "command", id: "b", command: evil },
    ]);
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelectorAll("svg")).toHaveLength(1);
    for (const el of root.querySelectorAll("*")) {
      expect(el.getAttributeNames().filter((a) => a.startsWith("on"))).toEqual([]);
      for (const a of el.getAttributeNames()) expect(el.getAttribute(a)).not.toContain("alert");
    }
    expect(root.textContent).toContain("<script>");
  });

  it("labels nodes, edges and caps, and summarizes for screen readers", () => {
    const root = mount(triage());
    const svg = root.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("5 on fail loops back to step 1");
    const texts = [...root.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toEqual(expect.arrayContaining(["1 · chat", "bug", "otherwise", "fail · ≤2×", "■ stop", "● end"]));
  });

  it("gives each diagram its own arrowhead ids", () => {
    const root = mount(triage());
    act(() => render(h("div", null, h(StepFlow, { steps: triage() }), h(StepFlow, { steps: triage() })), root));
    const ids = [...root.querySelectorAll("marker")].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
