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
