// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, test, vi } from "vitest";
import { createTaskBubbles, liveBadgeAgent } from "../src/renderer/task-bubbles.js";
import type { TaskJob } from "@bean/host";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
});
afterEach(() => { document.body.innerHTML = ""; });

const job = (id: string, patch: Partial<TaskJob>): TaskJob =>
  ({ id, kind: "routine", name: id, line: "step", detail: "", steps: ["one"], step: 0, startedAt: 0, state: "running", ...patch });

function mount(jobs: TaskJob[]) {
  const box = document.createElement("div");
  document.body.append(box);
  const onStop = vi.fn();
  const b = createTaskBubbles(box, () => {}, () => {}, () => {}, () => {}, () => {}, onStop);
  b.update(jobs);
  const open = (id: string): void => box.querySelector<HTMLElement>(`.bean-bubble[data-id="${id}"]`)!.click();
  return { box, b, onStop, open };
}

test("Stop renders only in an expanded running sprout bubble, outside the bubble button", () => {
  const { box, onStop, open } = mount([
    job("routine:r:1", { routine: "r", name: "fix the login bug" }),
    job("delegate:1", { kind: "delegate" }),
    job("routine:done", { routine: "done", state: "done" }),
  ]);
  expect(box.querySelector(".bean-bubble-stop")).toBeNull(); // collapsed
  open("delegate:1");
  expect(box.querySelector(".bean-bubble-stop")).toBeNull();
  open("routine:r:1");
  const stop = box.querySelector<HTMLButtonElement>(".bean-bubble-stop")!;
  expect(stop.textContent).toBe("Stop");
  expect(stop.closest(".bean-bubble")).toBeNull();
  stop.click();
  expect(onStop).toHaveBeenCalledExactlyOnceWith("r");
  // Clicking Stop doesn't toggle the bubble shut.
  expect(box.querySelector(".bean-bubble-stop")).not.toBeNull();
});

test("Stop names every live run of the sprout, disables while stopping, and keeps focus across re-renders", () => {
  const jobs = [job("routine:r:1", { routine: "r" }), job("routine:r:2", { routine: "r" })];
  const { box, b, open } = mount(jobs);
  open("routine:r:1");
  const stop = box.querySelector<HTMLButtonElement>(".bean-bubble-stop")!;
  expect(stop.textContent).toBe("Stop all 2 runs");
  stop.focus();
  b.update([...jobs]); // a step event re-renders the stack
  expect(document.activeElement?.classList.contains("bean-bubble-stop")).toBe(true);
  b.update(jobs.map((j) => ({ ...j, line: "Stopping…" })));
  const stopping = box.querySelector<HTMLButtonElement>(".bean-bubble-stop")!;
  expect(stopping.disabled).toBe(true);
  expect(stopping.textContent).toBe("Stopping…");
  expect((document.activeElement as HTMLElement).dataset.id).toBe("routine:r:1");
});

describe("liveBadgeAgent", () => {
  const job = (p: Partial<TaskJob>): TaskJob => ({ id: "j", kind: "live", name: "", line: "", detail: "", startedAt: 0, state: "running", ...p });

  it("wears the newest running desktop session's agent, and clears on end or crash", () => {
    expect(liveBadgeAgent([job({ agent: "claude", startedAt: 1 }), job({ agent: "codex", startedAt: 2 })])).toBe("codex");
    expect(liveBadgeAgent([job({ agent: "claude", state: "done" }), job({ agent: "codex", state: "failed" })])).toBeUndefined();
  });

  it("ignores chatops live sessions (reported as delegate jobs)", () => {
    expect(liveBadgeAgent([job({ kind: "delegate", name: "proj · live" })])).toBeUndefined();
  });
});
