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
