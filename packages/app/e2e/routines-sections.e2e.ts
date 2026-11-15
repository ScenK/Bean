import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** The Sprouts list is sectioned by project from the registry and each step's folder; Needs
 * fixing offers Register / Pick projects; the fold lives in localStorage — so this drives the
 * real app twice against one userData dir. */
test("sprouts window: project sections, Needs fixing, Listed under, fold survives a restart", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const loose = await mkdtemp(join(tmpdir(), "bean-e2e-loose-"));
  const beanDir = join(home.homeDir, ".bean");
  const sprout = (name: string, folder: string) => writeFile(join(beanDir, "routines", `${name}.json`), JSON.stringify({
    name, enabled: false, cron: "0 3 * * *", sinks: {},
    steps: [{ kind: "delegate", instruction: "check", project: folder }],
  }), "utf8");
  await sprout("in-demo", join(home.projectPath, "sub"));
  await sprout("loose-one", loose);
  // The temp dir holds the registered project: an ancestor folder is never offered for registering.
  await sprout("above", dirname(home.projectPath));

  const open = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    return win;
  };
  const section = (win: Page, key: string) => win.locator(`.bean-routines-section[data-section="${key}"]`);
  const row = (win: Page, key: string, name: string) => section(win, key).locator(".bean-routines-row", { hasText: name });
  const fix = "!needs-fixing";

  const env = { HOME: home.homeDir, OPENAI_BASE_URL: stub.url };
  try {
    const app = await launchBean(env, userDataDir);
    try {
      const win = await open(app);
      await expect(row(win, home.projectPath, "in-demo")).toBeVisible();
      await expect(row(win, "", "nightly")).toBeVisible();
      await expect(row(win, fix, "above")).toContainText("not a project");
      await expect(row(win, fix, "above").getByRole("button", { name: "Register folder" })).toHaveCount(0);

      win.once("dialog", (d) => void d.accept());
      await row(win, fix, "loose-one").getByRole("button", { name: "Register folder" }).click();
      await expect(row(win, loose, "loose-one")).toBeVisible();
      const registry = JSON.parse(await readFile(join(beanDir, "projects.json"), "utf8")) as { name: string; path: string }[];
      expect(registry).toContainEqual({ name: basename(loose), path: loose });

      // Pick projects… opens the editor; toggling Listed under keeps an unsaved edit.
      await row(win, fix, "above").getByRole("button", { name: "Pick projects…" }).click();
      await win.locator(".bean-routines-desc-text").fill("unsaved note");
      await win.locator(".bean-routines-listed").getByRole("button", { name: "demo", exact: true }).click();
      await expect(win.locator(".bean-routines-desc-text")).toHaveValue("unsaved note");
      await win.getByRole("button", { name: "Save sprout" }).click();
      await expect(row(win, home.projectPath, "above")).toBeVisible();
      await expect(section(win, fix)).toHaveCount(0);

      await section(win, home.projectPath).locator(".bean-notes-group").click();
      await expect(row(win, home.projectPath, "in-demo")).toHaveCount(0);
    } finally {
      await app.close();
    }

    const restarted = await launchBean(env, userDataDir);
    try {
      const win = await open(restarted);
      await expect(row(win, "", "nightly")).toBeVisible();
      await expect(section(win, home.projectPath).locator(".bean-notes-group")).toHaveAttribute("aria-expanded", "false");
      await expect(row(win, home.projectPath, "in-demo")).toHaveCount(0);
    } finally {
      await restarted.close();
    }
  } finally {
    await Promise.allSettled([stub.close(), home.cleanup(), rm(userDataDir, { recursive: true, force: true }), rm(loose, { recursive: true, force: true })]);
  }
});
