import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("proposal (terminal target): confirming calls window.bean.launch, never a real process", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  // Depends on .bean/skills/review-pr.md's current name + `target: terminal` frontmatter.
  stub.queue({
    toolCall: { name: "propose_run", args: { skill: "review-pr", project: home.projectPath, instruction: "review PR 1" } },
  });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("review PR 1");
    await chat.locator(".bean-send").click();

    const card = chat.locator(".bean-card");
    await expect(card).toContainText("review-pr");

    // Derive the deterministic expected pair from Bean's own enabled catalog instead of
    // assuming the CI host has opencode (rather than Claude or Codex) installed. The first
    // configured model whose provider is enabled is the card's default.
    const expected = await chat.evaluate(async () => {
      const bean = (window as unknown as { bean: {
        availableClis: () => Promise<string[]>;
        availableModels: () => Promise<{ id: string; availableOn: string[] }[]>;
      } }).bean;
      const [clis, models] = await Promise.all([bean.availableClis(), bean.availableModels()]);
      const model = models.find((candidate) => candidate.availableOn.some((cli) => clis.includes(cli)));
      const cli = model?.availableOn.find((candidate) => clis.includes(candidate));
      return { cli, model: model?.id };
    });
    expect(expected.cli).toBeTruthy();

    // `contextBridge.exposeInMainWorld` deep-freezes the exposed `window.bean` api object
    // (verified: its own property descriptor and `.launch`'s are both non-configurable,
    // non-writable), so spying by reassigning anything on `window.bean` from the renderer is
    // a silent no-op. Intercept one level down instead, at the real IPC boundary
    // `window.bean.launch()` sends to: swap the main process's "bean:launch" listener for a
    // spy before confirming, so the request never reaches launchInTerminal/child_process.spawn.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeAllListeners("bean:launch");
      ipcMain.on("bean:launch", (_event, req: unknown) => {
        (globalThis as unknown as { __lastLaunch?: unknown }).__lastLaunch = req;
      });
    });
    await card.locator(".bean-btn").first().click(); // "Confirm & run"

    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __lastLaunch?: unknown }).__lastLaunch))
      .toMatchObject({ mode: expected.cli, model: expected.model, projectPath: home.projectPath });
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
