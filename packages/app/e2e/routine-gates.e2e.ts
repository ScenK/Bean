import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** A gate authored in the step editor survives save + reload: ids are assigned for you, the
 * goto points at the first step's id, and the rail draws the loop marker again on reopen. */
test("routines: add a loop gate in the editor, save, reload, edges intact", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const file = join(home.homeDir, ".bean", "routines", "dev-loop.json");
  await writeFile(file, JSON.stringify({
    name: "dev-loop", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: [{ kind: "chat", instruction: "implement" }, { kind: "chat", instruction: "review it" }],
  }), "utf8");

  const openRoutine = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "dev-loop" }).click();
    await expect(win.locator(".bean-routines-step")).toHaveCount(2);
    return win;
  };

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const win = await openRoutine(app);
    const second = win.locator(".bean-routines-step").nth(1);
    await second.getByRole("button", { name: /if it fails · keep going/ }).click();
    await win.getByRole("button", { name: /Go to → step 1/ }).click();
    await expect(second.getByRole("button", { name: /max rounds · 3/ })).toBeVisible();
    await expect(second.locator(".bean-routines-step-edge")).toHaveText("↩1");
    await win.getByRole("button", { name: "Save sprout" }).click();

    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(file, "utf8")) as { steps: { id?: string; gate?: { onFail: { goto: string } } }[] };
      return saved.steps[0]?.id !== undefined && saved.steps[1]?.gate?.onFail.goto === saved.steps[0]?.id;
    }).toBe(true);

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "dev-loop" }).click();
    const reopened = win.locator(".bean-routines-step").nth(1);
    await expect(reopened.getByRole("button", { name: /if it fails · go to 1/ })).toBeVisible();
    await expect(reopened.locator(".bean-routines-step-edge")).toHaveText("↩1");
    await expect(win.locator(".bean-routines-step-edge-problem")).toHaveCount(0);
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** Duplicate inserts an exact copy below with a fresh id: no edge problem, and it saves. */
test("routines: duplicate a step, save, copy has a unique id", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const file = join(home.homeDir, ".bean", "routines", "dup.json");
  await writeFile(file, JSON.stringify({
    name: "dup", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: [{ kind: "chat", instruction: "implement" }, { kind: "chat", instruction: "review it" }],
  }), "utf8");

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "dup" }).click();
    await expect(win.locator(".bean-routines-step")).toHaveCount(2);
    await win.locator(".bean-routines-step").first().getByRole("button", { name: "Duplicate" }).click();
    await expect(win.locator(".bean-routines-step")).toHaveCount(3);
    await expect(win.locator(".bean-routines-step-edge-problem")).toHaveCount(0);
    await win.getByRole("button", { name: "Save sprout" }).click();

    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(file, "utf8")) as { steps: { id?: string; instruction?: string }[] };
      const ids = saved.steps.map((s) => s.id);
      return saved.steps.length === 3 && saved.steps[1]?.instruction === "implement" && new Set(ids).size === 3 && !ids.includes(undefined);
    }).toBe(true);
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** A multi-way decision built entirely in the editor: "Choose a path…", two labeled paths
 * (one to a step, one ending the run), save, reload — the ⑂ badge and captions come back. */
test("routines: build a route in the editor, save, reload, paths intact", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const file = join(home.homeDir, ".bean", "routines", "triage.json");
  await writeFile(file, JSON.stringify({
    name: "triage", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: [{ kind: "chat", instruction: "classify" }, { kind: "chat", instruction: "fix the bug" }, { kind: "chat", instruction: "report" }],
  }), "utf8");

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "triage" }).click();
    const first = win.locator(".bean-routines-step").first();
    await first.getByRole("button", { name: /if it fails · keep going/ }).click();
    await win.getByRole("button", { name: /Choose a path/ }).click();
    await expect(first.getByRole("button", { name: /decides · 2 paths/ })).toBeVisible();

    await first.getByLabel("Path 1 label").fill("bug");
    await first.locator(".bean-routines-route-row").nth(0).getByRole("button", { name: /choose/ }).click();
    await win.getByRole("button", { name: /→ step 2/ }).click();
    await first.getByLabel("Path 2 label").fill("question");
    await first.locator(".bean-routines-route-row").nth(1).getByRole("button", { name: /choose/ }).click();
    await win.getByRole("button", { name: /end run/ }).click();
    await expect(first.locator(".bean-routines-step-edge")).toHaveText("⑂2");
    await expect(win.locator(".bean-routines-step").nth(1).locator(".bean-routines-step-path")).toHaveText("on path · bug");
    await expect(win.locator(".bean-routines-step-edge-problem")).toHaveCount(0);
    await win.getByRole("button", { name: "Save sprout" }).click();

    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(file, "utf8")) as { steps: { id?: string; route?: { paths: { when: string; goto: string }[] } }[] };
      const paths = saved.steps[0]?.route?.paths;
      return paths?.[0]?.when === "bug" && paths[0].goto === saved.steps[1]?.id && paths[1]?.when === "question" && paths[1].goto === "end";
    }).toBe(true);

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "triage" }).click();
    await expect(win.locator(".bean-routines-step").first().locator(".bean-routines-step-edge")).toHaveText("⑂2");
    await expect(win.locator(".bean-routines-step").nth(1).locator(".bean-routines-step-path")).toHaveText("on path · bug");
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** A parallel group built keyboard-only: toggling under a gated step flags that step (its gate is
 * kept), later members are disabled targets, and once the gate is cleared the group saves. */
test("routines: build a parallel group from the keyboard, save, alongside intact", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const file = join(home.homeDir, ".bean", "routines", "checks.json");
  await writeFile(file, JSON.stringify({
    name: "checks", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: [
      { kind: "chat", id: "lint", instruction: "lint", gate: { onFail: "stop" } },
      { kind: "chat", instruction: "test" },
      { kind: "chat", instruction: "review" },
      { kind: "chat", instruction: "triage" },
    ],
  }), "utf8");

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "checks" }).click();
    const step = (n: number) => win.locator(".bean-routines-step").nth(n);
    await expect(step(0).getByRole("button", { name: /alongside/ })).toHaveCount(0);

    await step(1).getByRole("button", { name: "⫴ alongside step 1" }).focus();
    await win.keyboard.press("Space");
    await expect(step(1).getByRole("button", { name: "⫴ alongside step 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(step(0).locator(".bean-routines-step-edge-problem")).toContainText("runs alongside it, so it can't have a gate");
    await expect(step(0).getByRole("button", { name: /if it fails · stop/ })).toBeVisible();

    await step(2).getByRole("button", { name: "⫴ alongside step 1" }).focus();
    await win.keyboard.press("Enter");
    await expect(step(0).locator(".bean-routines-step-edge", { hasText: "⫴" })).toHaveText("⫴3");
    await expect(step(0)).toContainText("starts a group of 3 · joins at 4");
    await expect(step(2)).toContainText("runs alongside 1");
    await expect(step(3)).toContainText("waits for steps 1–3");
    await expect(step(1).getByRole("button", { name: /if it fails|then/ })).toHaveCount(0);

    await step(3).getByRole("button", { name: /if it fails · keep going/ }).click();
    await expect(win.getByRole("button", { name: /Go to → step 2/ })).toBeDisabled();
    await expect(win.getByRole("button", { name: /Go to → step 2/ })).toContainText("runs alongside step 1 — go to step 1 to run the group");
    await expect(win.getByRole("button", { name: /Go to → step 1/ })).toBeEnabled();

    await step(0).getByRole("button", { name: /if it fails · stop/ }).click();
    await win.getByRole("button", { name: /Keep going/ }).click();
    await expect(win.locator(".bean-routines-step-edge-problem")).toHaveCount(0);
    await expect(step(0).getByRole("button", { name: /if it fails/ })).toHaveCount(0);
    await win.getByRole("button", { name: "Save sprout" }).click();

    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(file, "utf8")) as { steps: { alongside?: boolean; gate?: unknown }[] };
      return saved.steps.map((s) => `${s.alongside ?? "-"}${s.gate ? "g" : ""}`).join(" ");
    }).toBe("- true true -");
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});
