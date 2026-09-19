import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { saveNote } from "@bean/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** The notes sidebar remembers folded project groups in the renderer's localStorage. That only
 * works if file:// pages get storage at all and if it survives a restart — neither is provable
 * from a unit test, so this drives the real app twice against one userData dir. */
test("notes sidebar: a folded project group stays folded across a restart", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const db = join(home.homeDir, ".bean", "bean.db");
  await saveNote(db, { title: "Alpha note", body: "first", project: home.projectPath, source: "manual" });

  const open = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("notes")),
    ]);
    return win;
  };

  const env = { HOME: home.homeDir, OPENAI_BASE_URL: stub.url };
  try {
    const app = await launchBean(env, userDataDir);
    try {
      const notes = await open(app);
      const header = notes.locator(".bean-notes-group", { hasText: "demo" });
      await expect(header).toBeVisible();
      await expect(notes.locator(".bean-notes-row-text", { hasText: "Alpha note" })).toBeVisible();

      await header.click();
      await expect(notes.locator(".bean-notes-row-text", { hasText: "Alpha note" })).toHaveCount(0);
    } finally {
      await app.close();
    }

    const restarted = await launchBean(env, userDataDir);
    try {
      const notes = await open(restarted);
      await expect(notes.locator(".bean-notes-group", { hasText: "demo" })).toBeVisible();
      await expect(notes.locator(".bean-notes-row-text", { hasText: "Alpha note" })).toHaveCount(0);
    } finally {
      await restarted.close();
    }
  } finally {
    // Outer, so a failed assertion in either launch can't leak the stub server, the fixture
    // HOME, or the userData dir this test owns (launchBean only self-cleans dirs it made).
    await Promise.allSettled([stub.close(), home.cleanup(), rm(userDataDir, { recursive: true, force: true })]);
  }
});
