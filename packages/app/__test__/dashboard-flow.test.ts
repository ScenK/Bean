// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { DashboardPanel } from "../src/renderer/components/dashboard/DashboardPanel.js";

afterEach(() => { document.body.innerHTML = ""; });

const run = (startedAt: string) => ({
  startedAt, finishedAt: startedAt, status: "ok", digest: "",
  steps: [{ kind: "chat", id: "a", round: 1, ok: true, summary: "done" }],
});

it("opens only the latest run's flow; Show flow ▾ opens an older one", async () => {
  const routine = { name: "nightly", enabled: true, cron: "0 22 * * *", steps: [{ kind: "chat", id: "a", instruction: "x" }], sinks: {} };
  (window as unknown as { bean: unknown }).bean = {
    routinesList: async () => [routine],
    routinesState: async () => ({ nightly: { running: false, history: [run("2026-01-02T14:00:00Z"), run("2026-01-02T13:00:00Z")] } }),
    onDashboardTarget: () => {},
    getPendingDashboardTarget: async () => undefined,
  };
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => { render(h(DashboardPanel, {}), root); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const heads = () => [...root.querySelectorAll(".bean-dash-flow .bean-dash-digest-head")] as HTMLButtonElement[];
  expect(heads().map((b) => b.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  expect(root.querySelectorAll(".bean-flow-svg")).toHaveLength(1);
  expect(heads()[1]!.textContent).toContain("Show flow ▾");
  await act(async () => { heads()[1]!.click(); });
  expect(root.querySelectorAll(".bean-flow-svg")).toHaveLength(2);
  expect(root.querySelector(".bean-flow-node--ran")).not.toBeNull();
});

it("badges the flow with the sessions a run's attempts shared, loading them when the flow opens", async () => {
  const d = (id: string) => ({ kind: "delegate", id, skill: "", cli: "claude", instruction: "x" });
  // Today's definition says nothing about sessions; the attempts do.
  const routine = { name: "nightly", enabled: true, cron: "0 22 * * *", steps: [d("a"), d("b"), d("c")], sinks: {} };
  const record = {
    id: "r1", startedAt: "2026-01-02T14:00:00Z", finishedAt: "2026-01-02T14:00:00Z", status: "ok", digest: "",
    steps: ["a", "b", "c"].map((id) => ({ kind: "delegate", id, round: 1, ok: true, summary: "done" })),
  };
  const at = (stepIndex: number, resume: string) => ({ stepIndex, stepId: "abc"[stepIndex], round: 1, kind: "delegate", cli: "claude", ok: true, output: "done", resume });
  const calls: string[] = [];
  (window as unknown as { bean: unknown }).bean = {
    routinesList: async () => [routine],
    routinesState: async () => ({ nightly: { running: false, history: [record] } }),
    routinesAttempts: async (runId: string) => {
      calls.push(runId);
      return [at(0, "claude --resume A"), at(1, "claude --resume B"), at(2, "claude --resume A")];
    },
    onDashboardTarget: () => {},
    getPendingDashboardTarget: async () => undefined,
  };
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => { render(h(DashboardPanel, {}), root); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(calls).toEqual(["r1"]);
  const badges = [...root.querySelectorAll(".bean-flow-title")].map((t) => t.querySelector(".bean-flow-lane")?.textContent?.trim() ?? null);
  expect(badges).toEqual(["↻1", null, "↻1"]);
  // FULL OUTPUT shows what's already loaded: one resume block per session, on its last attempt.
  const full = [...root.querySelectorAll(".bean-dash-digest-head")].find((b) => b.textContent?.includes("FULL OUTPUT")) as HTMLButtonElement;
  await act(async () => { full.click(); });
  expect(calls).toEqual(["r1"]);
  expect(root.querySelector(".bean-dash-sessions")!.textContent).toBe("2 agent sessions · ↻1 steps 1→3 (claude)");
  const attempts = [...root.querySelectorAll(".bean-dash-attempt")];
  expect(attempts.map((a) => a.querySelector(".bean-dash-resume code")?.textContent ?? null)).toEqual([null, "claude --resume B", "claude --resume A"]);
  expect(attempts[0]!.textContent).toContain("↻ session 1");
  expect(attempts[0]!.textContent).toContain("↻ continued in c");
  expect(attempts[1]!.textContent).not.toContain("↻");
});
