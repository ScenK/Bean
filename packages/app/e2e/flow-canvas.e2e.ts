import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** The flow canvas spans its panel's content width and caps its height, scrolling inside the
 * sprout editor. A 3-step sprout fits without a scrollbar. */
test("flow canvas: full panel width, capped height that scrolls", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const routines = join(home.homeDir, ".bean", "routines");
  const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
  await writeFile(join(routines, "long.json"), JSON.stringify({
    name: "long", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: ids.map((id) => ({ kind: "chat", id, instruction: `do ${id}` })),
  }), "utf8");

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
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** A parallel group draws as one labelled frame around its members in the editor. */
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
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});
