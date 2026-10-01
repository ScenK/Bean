import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** Folding a split window's list column hides it, gives the detail the full width, keeps the
 * list's state (it stays mounted), and is remembered per window across a restart. */
test("split windows: folded list column survives unfold and a restart, per window", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));

  const open = async (app: ElectronApplication, kind: string): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate((k) => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent(k), kind),
    ]);
    return win;
  };

  const env = { HOME: home.homeDir, OPENAI_BASE_URL: stub.url };
  try {
    const app = await launchBean(env, userDataDir);
    try {
      const skills = await open(app, "skills");
      const list = skills.locator(".bean-skills-list");
      await expect(list).toBeVisible();
      await skills.locator(".bean-skills-search-input").fill("review");

      await skills.getByRole("button", { name: "Hide list" }).click();
      await expect(list).toBeHidden();
      const width = await skills.evaluate(() => window.innerWidth);
      const detail = await skills.locator(".bean-skills-detail").boundingBox();
      expect(detail?.width ?? 0).toBeGreaterThan(width - 4);

      await skills.getByRole("button", { name: "Show list" }).click();
      await expect(list).toBeVisible();
      await expect(skills.locator(".bean-skills-search-input")).toHaveValue("review");

      await skills.getByRole("button", { name: "Hide list" }).click();
      await expect(list).toBeHidden();
    } finally {
      await app.close();
    }

    const restarted = await launchBean(env, userDataDir);
    try {
      const skills = await open(restarted, "skills");
      await expect(skills.getByRole("button", { name: "Show list" })).toBeVisible();
      await expect(skills.locator(".bean-skills-list")).toBeHidden();

      const dashboard = await open(restarted, "dashboard");
      await expect(dashboard.getByRole("button", { name: "Hide list" })).toBeVisible();
      await expect(dashboard.locator(".bean-skills-list")).toBeVisible();
    } finally {
      await restarted.close();
    }
  } finally {
    await Promise.allSettled([stub.close(), home.cleanup(), rm(userDataDir, { recursive: true, force: true })]);
  }
});
