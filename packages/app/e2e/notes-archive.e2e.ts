import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { saveNote } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** Archive → the row moves under the (folded-by-default) Archive group with a read-only view;
 * Restore → it's back in its project group. Drives the real IPC + preload path end to end. */
test("notes: archive moves a note to the Archive group and restore brings it back", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const db = `${home.homeDir}/.bean/bean.db`;
  await saveNote(db, { title: "Alpha note", body: "first", project: home.projectPath, source: "manual" });

  const open = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("notes")),
    ]);
    return win;
  };

  try {
    const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
    try {
      const notes = await open(app);
      const row = notes.locator(".bean-notes-idx", { hasText: "Alpha note" });
      await row.click();
      await notes.locator(".bean-notes-archive").click();

      // Archived and still selected: the read-only view, with no Edit.
      await expect(notes.locator(".bean-notes-archived-meta")).toContainText("Archived");
      await expect(notes.locator("button", { hasText: "Edit note" })).toHaveCount(0);
      await expect(notes.locator(".bean-notes-group", { hasText: "demo" })).toHaveCount(0);
      const archiveGroup = notes.locator(".bean-notes-group", { hasText: "Archive" });
      await expect(archiveGroup).toHaveAttribute("aria-expanded", "false");
      await archiveGroup.click();
      await expect(notes.locator(".bean-notes-idx--archived", { hasText: "Alpha note" })).toBeVisible();

      await notes.locator(".bean-notes-restore").click();
      await expect(archiveGroup).toHaveCount(0);
      await expect(notes.locator(".bean-notes-group", { hasText: "demo" })).toBeVisible();
      await expect(notes.locator(".bean-notes-idx:not(.bean-notes-idx--archived)", { hasText: "Alpha note" })).toBeVisible();
      await expect(notes.locator("button", { hasText: "Edit note" })).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});
