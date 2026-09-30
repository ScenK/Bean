import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { appendMemories, dbFile } from "@bean/core";
import { join } from "node:path";

// #177: closing a chat is instant (no review card), extraction runs in main, a memory bubble
// appears, and clicking it opens Persona where Undo deletes exactly that batch.
test("auto memory: close without a card, bubble shown, Undo works", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Noted!" }); // the chat turn
  stub.queue({ toolCall: { name: "remember", args: { text: "Prefers pnpm over npm", quote: "I prefer pnpm" } } }); // close-time extraction
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("I prefer pnpm over npm");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Noted!");

    const started = Date.now();
    const closed = chat.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("chat"))!.close();
    });
    await closed;
    // ponytail: 200ms is the product bar; e2e allows CI jitter on top.
    expect(Date.now() - started).toBeLessThan(1500);

    const bubble = avatar.locator('.bean-bubble[data-id="memory:batch"]');
    await expect(bubble).toContainText("I remember things automatically now"); // fresh userData: first-run notice

    const [persona] = await Promise.all([app.waitForEvent("window"), bubble.click()]);
    await persona.waitForLoadState("domcontentloaded");
    const just = persona.locator(".bean-memory-just");
    await expect(just.locator("input")).toHaveValue("Prefers pnpm over npm");
    await just.getByRole("button", { name: "Undo" }).click();
    await expect(just).toHaveCount(0);
    await expect(persona.locator(".bean-memory-empty")).toBeVisible();
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #177 PR 2: with ≥5 memories saved since the last dream (none yet), the close that saves the
// next batch also dreams; the digest shows as a bubble and Persona's "Last dream" row undoes it.
test("dream: a due close tidies memory in the background and Undo last dream restores it", async () => {
  const home = await makeBeanHome();
  const file = dbFile(join(home.homeDir, ".bean"));
  await appendMemories(file, ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `seed fact ${id}`, createdAt: "2026-08-01T00:00:00.000Z" })));
  const stub = await startStubOpenAI();
  stub.queue({ content: "Noted!" });
  stub.queue({ toolCall: { name: "remember", args: { text: "Prefers pnpm over npm", quote: "I prefer pnpm" } } });
  stub.queue({ toolCall: { name: "drop_memory", args: { id: "a" } } }); // the dream pass
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("I prefer pnpm over npm");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Noted!");
    const closed = chat.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("chat"))!.close();
    });
    await closed;

    const bubble = avatar.locator('.bean-bubble[data-id="memory:dream"]');
    await expect(bubble).toContainText("Tidied memory: removed 1");
    const [persona] = await Promise.all([app.waitForEvent("window"), bubble.click()]);
    await persona.waitForLoadState("domcontentloaded");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(5); // a dropped, pnpm added
    await persona.getByRole("button", { name: /Details/ }).click();
    await expect(persona.locator(".bean-memory-dream-row")).toContainText("seed fact a → removed");
    await persona.locator(".bean-memory-just", { hasText: "Last dream" }).getByRole("button", { name: "Undo" }).click();
    await expect(persona.getByText("Last dream")).toHaveCount(0);
    await expect(persona.locator(".bean-memory-input")).toHaveCount(6);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
