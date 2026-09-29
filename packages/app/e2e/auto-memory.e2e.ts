import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

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
