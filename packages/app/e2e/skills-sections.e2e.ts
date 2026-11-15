import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** The Skills list is sectioned by usage from the host's `usedBy`, and each section's fold lives
 * in the renderer's localStorage — so this drives the real app twice against one userData dir. */
test("skills window: usage sections, fold survives a restart, a moved row stays selected", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const beanDir = join(home.homeDir, ".bean");
  // Sprout-only: off the avatar, in no project, named by a sprout step.
  await writeFile(join(beanDir, "skills", "nightly-step.md"), "---\ntarget: terminal\nquick-launch: false\ndescription: Nightly\n---\n\n# Nightly\n", "utf8");
  await writeFile(join(beanDir, "routines", "nightly-check.json"), JSON.stringify({
    name: "nightly-check", enabled: false, cron: "0 3 * * *",
    steps: [{ kind: "delegate", skill: "nightly-step", instruction: "check" }], sinks: {},
  }), "utf8");

  const open = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("skills")),
    ]);
    return win;
  };
  const section = (win: Page, key: string) => win.locator(`.bean-skills-section[data-section="${key}"]`);
  const row = (win: Page, key: string, name: string) => section(win, key).locator(".bean-skills-row", { hasText: name });

  const env = { HOME: home.homeDir, OPENAI_BASE_URL: stub.url };
  try {
    const app = await launchBean(env, userDataDir);
    try {
      const win = await open(app);
      await expect(row(win, "skills", "review-pr")).toContainText("↻ review-queue");
      await expect(section(win, "sprout-steps").locator(".bean-notes-group")).toHaveAttribute("aria-expanded", "false");
      await expect(row(win, "sprout-steps", "nightly-step")).toHaveCount(0);

      await section(win, "sprout-steps").locator(".bean-notes-group").click();
      await expect(row(win, "sprout-steps", "nightly-step")).toContainText("↻ nightly-check");
    } finally {
      await app.close();
    }

    const restarted = await launchBean(env, userDataDir);
    try {
      const win = await open(restarted);
      await expect(row(win, "sprout-steps", "nightly-step")).toBeVisible();

      await row(win, "sprout-steps", "nightly-step").click();
      await win.locator(".bean-skills-toggle-pair").nth(1).locator("button").click();
      await expect(row(win, "skills", "nightly-step")).toHaveClass(/bean-skills-row--selected/);
      await expect(section(win, "sprout-steps")).toHaveCount(0);
    } finally {
      await restarted.close();
    }
  } finally {
    await Promise.allSettled([stub.close(), home.cleanup(), rm(userDataDir, { recursive: true, force: true })]);
  }
});
