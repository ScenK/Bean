import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** The flow canvas spans its panel's content width and caps its height, scrolling inside — in the
 * sprout editor and in a Dashboard run. A 3-step sprout fits without a scrollbar. */
test("flow canvas: full panel width, capped height that scrolls", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const routines = join(home.homeDir, ".bean", "routines");
  const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
  await writeFile(join(routines, "long.json"), JSON.stringify({
    name: "long", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: ids.map((id) => ({ kind: "chat", id, instruction: `do ${id}` })),
  }), "utf8");
  // Newest run of all, so the Dashboard opens on it with its flow expanded.
  const stateFile = join(routines, ".state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
  state.long = {
    lastRun: "2026-01-05T14:00:00.000Z",
    history: [{
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startedAt: "2026-01-05T14:00:00.000Z", finishedAt: "2026-01-05T14:30:00.000Z", status: "ok", digest: "done",
      steps: ids.map((id) => ({ kind: "chat", id, ok: true, summary: id })),
    }],
  };
  await writeFile(stateFile, JSON.stringify(state), "utf8");

  const open = async (app: ElectronApplication, kind: string): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate((k) => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent(k), kind),
    ]);
    return win;
  };
  const measure = (flow: Locator) => flow.evaluate((el) => {
    const parent = el.parentElement!;
    const cs = getComputedStyle(parent);
    return {
      width: el.getBoundingClientRect().width,
      parentContent: parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      height: el.getBoundingClientRect().height,
      cap: Math.min(720, Math.max(320, window.innerHeight * 0.65)),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  const expectFullWidthAndScrolls = async (flow: Locator): Promise<void> => {
    await expect(flow).toBeVisible();
    const m = await measure(flow);
    expect(Math.abs(m.width - m.parentContent)).toBeLessThanOrEqual(2);
    expect(m.height).toBeLessThanOrEqual(m.cap + 0.5);
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
  };

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const editor = await open(app, "routines");
    await editor.locator(".bean-routines-row", { hasText: "weekly" }).click();
    await expect(editor.locator(".bean-routines-step")).toHaveCount(3);
    const short = await measure(editor.locator(".bean-flow"));
    expect(Math.abs(short.width - short.parentContent)).toBeLessThanOrEqual(2);
    expect(short.scrollHeight).toBeLessThanOrEqual(short.clientHeight);

    await editor.locator(".bean-routines-row", { hasText: "long" }).click();
    await expect(editor.locator(".bean-routines-step")).toHaveCount(10);
    await expectFullWidthAndScrolls(editor.locator(".bean-flow"));
    await editor.locator(".bean-flow").focus();
    await expect(editor.locator(".bean-flow")).toBeFocused();

    const dashboard = await open(app, "dashboard");
    await expectFullWidthAndScrolls(dashboard.locator(".bean-dash-flow .bean-flow"));
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** A parallel group draws as one labelled frame around its members — in the editor, and lit on a
 * Dashboard run that went through it. */
test("flow canvas: a parallel group is a labelled frame", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const routines = join(home.homeDir, ".bean", "routines");
  const steps = [
    { kind: "chat", id: "a", instruction: "do a" },
    { kind: "chat", id: "b", instruction: "do b" },
    { kind: "chat", id: "c", instruction: "do c", alongside: true },
    { kind: "chat", id: "d", instruction: "do d" },
  ];
  await writeFile(join(routines, "fan.json"), JSON.stringify({ name: "fan", enabled: false, cron: "0 6 * * *", sinks: {}, steps }), "utf8");
  const stateFile = join(routines, ".state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
  state.fan = {
    lastRun: "2026-01-05T14:00:00.000Z",
    history: [{
      id: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
      startedAt: "2026-01-05T14:00:00.000Z", finishedAt: "2026-01-05T14:30:00.000Z", status: "ok", digest: "done",
      steps: steps.map(({ kind, id }) => ({ kind, id, ok: true, summary: id })),
    }],
  };
  await writeFile(stateFile, JSON.stringify(state), "utf8");

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const open = async (kind: string): Promise<Page> => {
      const [win] = await Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate((k) => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent(k), kind),
      ]);
      return win;
    };
    const editor = await open("routines");
    await editor.locator(".bean-routines-row", { hasText: "fan" }).click();
    await expect(editor.locator(".bean-flow .bean-flow-group")).toHaveCount(1);
    await expect(editor.locator(".bean-flow .bean-flow-group-label")).toHaveText("⫴ together · 2");

    const dashboard = await open("dashboard");
    const flow = dashboard.locator(".bean-dash-flow .bean-flow");
    await expect(flow.locator(".bean-flow-group")).toHaveClass(/bean-flow-accent/);
    // The fork bundle, the join and the ● end.
    await expect(flow.locator(".bean-flow-edge--lit")).toHaveCount(3);
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});
