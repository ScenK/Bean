// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { h, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import type { RoutineStep } from "@bean/core";
import { StepsEditor } from "../src/renderer/components/routines/StepsEditor.js";
import { moveStep, removeStep } from "../src/renderer/components/routines/step-ids.js";

const d = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep => ({ kind: "delegate", id, skill: "code", cli: "claude", instruction: id, ...extra } as RoutineStep);

let latest: RoutineStep[] = [];
const mount = (initial: RoutineStep[]): HTMLElement => {
  const root = document.createElement("div");
  document.body.append(root);
  latest = initial;
  const Host = () => {
    const [steps, setSteps] = useState(initial);
    return h(StepsEditor, { steps, onSteps: (next) => { latest = next; setSteps(next); }, skills: [], projects: [{ name: "Bean", path: "/p/bean" }], clis: ["claude", "codex"], models: [] });
  };
  act(() => render(h(Host, null), root));
  return root;
};
const cards = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".bean-routines-step-card")];
const chip = (card: HTMLElement): HTMLButtonElement | undefined =>
  [...card.querySelectorAll<HTMLButtonElement>(".bean-chip-menu-trigger")].find((b) => b.textContent!.includes("↻"));
const open = (card: HTMLElement): HTMLButtonElement[] => {
  act(() => chip(card)!.click());
  return [...card.querySelectorAll<HTMLButtonElement>(".bean-chip-menu-row")];
};

afterEach(() => { document.body.innerHTML = ""; });

describe("continue-session chip", () => {
  it("shows on delegate steps with an earlier delegate, lists only delegates, and disables an ineligible one with the validator's wording", () => {
    const root = mount([d("a"), { kind: "chat", id: "c", instruction: "c" }, d("b", { cli: "codex" }), d("e", { project: "/p/bean" }), d("f")]);
    const [first, chat, , , last] = cards(root);
    expect(chip(first!)).toBeUndefined();
    expect(chip(chat!)).toBeUndefined();
    expect(chip(last!)!.textContent).toContain("↻ new session");
    expect(chip(last!)!.className).toContain("--dashed");

    const rows = open(last!);
    expect(rows.map((r) => r.querySelector(".bean-chip-menu-row-title")!.textContent)).toEqual(["✓ new session", "↻ continue step 1", "↻ continue step 3", "↻ continue step 4"]);
    const [, ok, otherCli, otherProject] = rows;
    expect(ok!.disabled).toBe(false);
    expect(ok!.textContent).toContain("code · agent · claude · no project");
    expect(otherCli!.disabled).toBe(true);
    expect(otherCli!.className).toContain("--dimmed");
    expect(otherCli!.textContent).toContain("step 5: step 3 runs on codex, this step on claude — a session only continues on the same coding agent");
    expect(otherProject!.disabled).toBe(true);
    expect(otherProject!.textContent).toContain("code · agent · claude · Bean");
    expect(otherProject!.textContent).toContain("works in a different project");

    act(() => ok!.click());
    expect(latest[4]).toMatchObject({ continues: "a" });
    const [target, , , , cont] = cards(root);
    expect(chip(cont!)!.textContent).toContain("↻ continues step 1");
    expect(target!.textContent).toContain("its session continues in step 5");
    expect(cont!.textContent).toContain("continues step 1's session");
    expect(root.querySelector("svg")!.getAttribute("aria-label")).toContain("Shared sessions: steps 1, 5");
  });

  it("flags a dangling target after a delete or reorder, never fixing it", () => {
    const steps = [d("a"), d("b"), d("c", { continues: "b" })];

    const deleted = mount(removeStep(steps, 1));
    const cont = cards(deleted)[1]!;
    expect(chip(cont)!.textContent).toContain("↻ continues step ?");
    expect(cont.querySelector("[role=alert]")!.textContent).toBe('step 2: continues step "b" doesn\'t exist');
    document.body.innerHTML = "";

    const moved = mount(moveStep(steps, 2, 0));
    const first = cards(moved)[0]!;
    expect(chip(first)!.textContent).toContain("↻ continues step 3");
    expect(first.querySelector("[role=alert]")!.textContent).toBe("step 1: continues must point to an earlier step");
    // An unrelated edit keeps the broken field as it is.
    act(() => {
      const t = first.querySelector<HTMLTextAreaElement>("textarea")!;
      t.value = "edited";
      t.dispatchEvent(new Event("input"));
    });
    expect(latest[0]).toMatchObject({ continues: "b", instruction: "edited" });

    // Picking "new session" is the explicit clear.
    const [fresh] = open(cards(moved)[0]!);
    act(() => fresh!.click());
    expect("continues" in latest[0]!).toBe(false);
  });
});
