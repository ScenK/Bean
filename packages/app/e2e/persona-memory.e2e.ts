import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { appendMemories, dbFile, loadMemories, type Memory } from "@bean/core";
import { join } from "node:path";

// #651: Persona groups memory into You (with the "N of 15 always on" header), categories,
// Uncategorized, Channels (by source), Others (🔒 member rows, legacy "Name:" rows) and Projects;
// moving a row and renaming a heading persist across reopening the window.
test("persona memory: categorized sections, move a row, rename a heading", async () => {
  const home = await makeBeanHome();
  const file = dbFile(join(home.homeDir, ".bean"));
  const at = (i: number): string => new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString();
  const you: Memory[] = Array.from({ length: 16 }, (_, i) => ({
    id: `y${i}`, text: `You fact ${String(i).padStart(2, "0")}`, category: "You", createdAt: at(i),
  }));
  await appendMemories(file, [
    ...you,
    { id: "w1", text: "Uses zed at work", category: "Work", createdAt: at(20) },
    { id: "n1", text: "Likes tea", createdAt: at(21) },
    { id: "c1", text: "Sam: prefers rebase", sourceId: "discord:42", sourceTitle: "#eng", createdAt: at(22) },
    { id: "m1", text: "Alex's birthday is May 1", subjectId: "alex", createdAt: at(23) },
    { id: "l1", text: "Jo: ships on Fridays", createdAt: at(24) },
  ]);
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const open = async () => {
      const [win] = await Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("persona")),
      ]);
      await win.waitForLoadState("domcontentloaded");
      return win;
    };
    let persona = await open();
    const item = (id: string) => persona.locator(`.bean-memory-item[data-memory-id="${id}"]`);

    await expect(persona.getByText("You · 15 of 15 always on")).toBeVisible();
    await expect(persona.locator(".bean-memory-item--dim")).toHaveCount(1);
    await expect(item("y0")).toHaveClass(/bean-memory-item--dim/);
    await expect(persona.getByText("Uncategorized")).toBeVisible();

    const channel = persona.locator(".bean-memory-channel");
    await expect(channel).toHaveCount(1);
    await expect(channel.locator("summary")).toContainText("#eng");
    await channel.locator("summary").click();
    await expect(channel.locator(".bean-memory-input")).toHaveValue("Sam: prefers rebase");
    await expect(item("c1")).toHaveCount(1); // only under Channels

    await expect(item("m1").locator(".bean-memory-private")).toHaveText("🔒");
    await expect(item("l1").locator(".bean-memory-cat")).toHaveCount(0); // Others: no category input

    // Move "Likes tea" into a new category, then rename that heading.
    await item("n1").locator(".bean-memory-cat").fill("Food");
    await item("n1").locator(".bean-memory-cat").press("Enter");
    const foodHeading = persona.getByRole("textbox", { name: "Rename category Food" });
    await expect(foodHeading).toHaveValue("Food");
    await foodHeading.fill("Drinks");
    await foodHeading.press("Enter");
    await expect(persona.getByRole("textbox", { name: "Rename category Drinks" })).toBeVisible();
    await expect.poll(async () => (await loadMemories(file)).find((m) => m.id === "n1")?.category).toBe("Drinks");

    const closed = persona.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("persona"))!.close();
    });
    await closed;
    persona = await open();
    await expect(persona.getByRole("textbox", { name: "Rename category Drinks" })).toBeVisible();
    await expect(item("n1").locator(".bean-memory-cat")).toHaveValue("Drinks");
    await expect(persona.getByText("Uncategorized")).toHaveCount(0);

    // Search keeps working across sections.
    await persona.getByRole("searchbox", { name: "Search memories" }).fill("rebase");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(1);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
