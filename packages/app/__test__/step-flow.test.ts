// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { RoutineStep } from "@bean/core";
import { stepFlow } from "@bean/core/routine-graph";
import { layoutStepFlow, NODE_H, NODE_W, type FlowBox, type FlowGroup } from "../src/renderer/shared/step-flow-layout.js";
import { StepFlow, type FlowOverlay } from "../src/renderer/shared/StepFlow.js";

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

describe("parallel groups", () => {
  // A 4-wide group that starts the sprout, then a join; a router forks into the group too.
  const wide = [s("a"), s("b", { alongside: true }), s("c", { alongside: true }), s("d", { alongside: true }), s("join")];
  const encloses = (g: FlowGroup, b: FlowBox): boolean => b.x >= g.x && b.x + NODE_W <= g.x + g.w && b.y >= g.y && b.y + NODE_H <= g.y + g.h;
  const ends = (d: string): [number, number] => d.split(/[ ,]/).slice(-2).map(Number) as [number, number];
  const starts = (d: string): [number, number] => d.slice(1).split(/[ ,]/).slice(0, 2).map(Number) as [number, number];
  const mount = (steps: RoutineStep[], overlay?: FlowOverlay): HTMLElement => {
    const root = document.createElement("div");
    document.body.append(root);
    act(() => { render(h(StepFlow, { steps, ...(overlay ? { overlay } : {}) }), root); });
    return root;
  };

  it("puts a group's members on one row in one frame, even a group that starts the sprout", () => {
    const layout = layoutStepFlow(stepFlow([s("start"), ...wide]));
    expect(new Set(layout.boxes.slice(1, 5).map((b) => b.row)).size).toBe(1);
    expect(layout.boxes[5]!.row).toBe(layout.boxes[1]!.row + 1);
    expect(layout.groups.map(({ first, n }) => [first, n])).toEqual([[1, 4]]);
    const [g] = layout.groups;
    expect(layout.boxes.map((b) => encloses(g!, b))).toEqual([false, true, true, true, true, false]);
    // Inside the gap the old bar used: the layout doesn't grow.
    expect(g!.y).toBe(layout.boxes[1]!.y - 8);
    expect(g!.h).toBe(NODE_H + 16);
    const first = layoutStepFlow(stepFlow(wide));
    expect(new Set(first.boxes.slice(0, 4).map((b) => b.row))).toEqual(new Set([0]));
    expect(first.groups.map(({ first, n }) => [first, n])).toEqual([[0, 4]]);
  });

  it("encloses exactly its members when a route sibling lands in the same row", () => {
    const steps = [s("r", { route: { paths: [{ when: "go", goto: "a" }, { when: "other", goto: "x" }] } }), s("x", { next: "end" }), s("a"), s("b", { alongside: true })];
    const layout = layoutStepFlow(stepFlow(steps));
    expect(new Set(layout.boxes.slice(1).map((b) => b.row)).size).toBe(1);
    expect(layout.boxes.map((b) => encloses(layout.groups[0]!, b))).toEqual([false, false, true, true]);
  });

  it("forks a bundle as one curve into the frame's top centre and joins as one from its bottom", () => {
    const layout = layoutStepFlow(stepFlow([s("start"), ...wide]));
    const g = layout.groups[0]!;
    const forks = layout.edges.filter((l) => l.edge.kind === "fork");
    const joins = layout.edges.filter((l) => l.edge.kind === "join");
    expect([forks.length, joins.length]).toEqual([4, 4]);
    expect(forks.map((l) => Boolean(l.repeat))).toEqual([false, true, true, true]);
    expect(joins.map((l) => Boolean(l.repeat))).toEqual([false, true, true, true]);
    expect(ends(forks[0]!.d)).toEqual([g.x + g.w / 2, g.y]);
    expect(starts(joins[0]!.d)).toEqual([g.x + g.w / 2, g.y + g.h]);
    expect(ends(joins[0]!.d)).toEqual([layout.boxes[5]!.x + NODE_W / 2, layout.boxes[5]!.y]);
  });

  it("joins a group straight into the next group's frame", () => {
    const steps = [s("a"), s("b", { alongside: true }), s("c"), s("d", { alongside: true })];
    const layout = layoutStepFlow(stepFlow(steps));
    const [g1, g2] = layout.groups;
    const drawn = layout.edges.filter((l) => !l.repeat);
    expect(drawn.map((l) => l.edge.kind)).toEqual(["join", "join"]);
    expect(starts(drawn[0]!.d)).toEqual([g1!.x + g1!.w / 2, g1!.y + g1!.h]);
    expect(ends(drawn[0]!.d)).toEqual([g2!.x + g2!.w / 2, g2!.y]);
    expect(drawn[1]!.cap).toEqual({ x: g2!.x + g2!.w / 2, y: g2!.y + g2!.h + 24 + 12 });
  });

  it("enters a route path into a group's frame, labelled once; one end cap under a group that ends the run", () => {
    const steps = [s("r", { route: { paths: [{ when: "go", goto: "a" }, { when: "skip", goto: "end" }] } }), s("a"), s("b", { alongside: true })];
    const root = mount(steps);
    expect([...root.querySelectorAll(".bean-flow-label title")].map((t) => t.textContent)).toEqual(["go", "skip", "otherwise"]);
    expect([...root.querySelectorAll(".bean-flow-cap")].map((t) => t.textContent)).toEqual(["● end", "■ stop", "● end"]);
    expect(root.querySelectorAll(".bean-flow-group")).toHaveLength(1);
    expect(root.querySelector(".bean-flow-group-label")!.textContent).toBe("⫴ together · 2");
    // go, skip, otherwise, and the group's one join to its ● end.
    expect(root.querySelectorAll(".bean-flow-edge")).toHaveLength(4);
    const g = layoutStepFlow(stepFlow(steps)).groups[0]!;
    const into = [...root.querySelectorAll(".bean-flow-edge")].find((p) => p.getAttribute("d")!.endsWith(`${g.x + g.w / 2},${g.y}`))!;
    expect(into.getAttribute("marker-end")).toMatch(/^url\(#/);
  });

  it("ends a loop back into a group at its frame's left edge", () => {
    const steps = [s("a"), s("b"), s("c", { alongside: true }), s("gate", { gate: { onFail: { goto: "b", maxRounds: 2 } } })];
    const layout = layoutStepFlow(stepFlow(steps));
    const loop = layout.edges.find((l) => l.edge.kind === "loop")!;
    expect(loop.d.endsWith(`H${layout.groups[0]!.x}`)).toBe(true);
  });

  it("lights the frame when a member ran, and the edges the run took", () => {
    const steps = [s("a"), s("b"), s("c", { alongside: true }), s("d")];
    const edges = stepFlow(steps).edges;
    const all = new Set(edges.map((_, k) => k).filter((k) => edges[k]!.kind === "fork" || edges[k]!.kind === "join"));
    const root = mount(steps, { counts: [1, 1, 1, 0], failed: [false, false, true, false], edges: all });
    expect(root.querySelector(".bean-flow-group")!.classList.contains("bean-flow-accent")).toBe(true);
    expect(root.querySelectorAll(".bean-flow-edge--lit")).toHaveLength(2);
    expect([...root.querySelectorAll(".bean-flow-title")].map((t) => t.textContent)).toContain("3 · chat ✗");
    document.body.innerHTML = "";
    const unrun = mount(steps, { counts: [1, 0, 0, 0], failed: [true, false, false, false], edges: new Set() });
    expect(unrun.querySelector(".bean-flow-group")!.classList.contains("bean-flow-line")).toBe(true);
    // The old fork/join bar was the diagram's only <line>.
    expect(unrun.querySelectorAll("line")).toHaveLength(0);
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
    // The drawn text, without the <title> that keeps a long label's full text.
    const texts = [...root.querySelectorAll("text")].map((t) => [...t.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(""));
    expect(texts).toEqual(expect.arrayContaining(["bug", "otherwise", "fail · ≤2×", "■ stop", "● end"]));
    expect(root.querySelector(".bean-flow-title")!.textContent).toBe("1 · chat");
    expect([...root.querySelectorAll("text > title")].map((t) => t.textContent)).toContain("otherwise");
  });

  it("clips a long route label but keeps its full text in a title", () => {
    const long = "needs-a-much-longer-look";
    const root = mount([s("r", { route: { paths: [{ when: long, goto: "end" }, { when: "b", goto: "end" }] } })]);
    const label = [...root.querySelectorAll("text.bean-flow-label")].find((t) => t.querySelector("title")?.textContent === long)!;
    expect(label.lastChild!.textContent).toBe("needs-a-muc…");
  });

  it("gives each diagram its own arrowhead ids", () => {
    const root = mount(triage());
    act(() => render(h("div", null, h(StepFlow, { steps: triage() }), h(StepFlow, { steps: triage() })), root));
    const ids = [...root.querySelectorAll("marker")].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("StepFlow overlay", () => {
  it("accents exactly the edges the run took, whatever the layout order", () => {
    const steps = [s("a"), s("b", { gate: { onFail: { goto: "a", maxRounds: 2 } } }), s("c")];
    const edges = stepFlow(steps).edges;
    const taken = new Set(edges.flatMap((e, k) => (e.kind === "loop" || (e.from === 0 && e.to === 1) ? [k] : [])));
    const root = document.createElement("div");
    document.body.append(root);
    act(() => { render(h(StepFlow, { steps, overlay: { counts: [2, 2, 0], failed: [false, true, false], edges: taken } }), root); });
    const lit = [...root.querySelectorAll(".bean-flow-edge--lit")];
    expect(lit).toHaveLength(2);
    expect(lit.some((p) => p.classList.contains("bean-flow-edge--loop"))).toBe(true);
    expect(root.querySelectorAll(".bean-flow-dim")).toHaveLength(1);
    expect(root.querySelector(".bean-flow-title")!.textContent).toContain("×2");
  });
});
