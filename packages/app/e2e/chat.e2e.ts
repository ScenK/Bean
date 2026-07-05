import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("chat: sending a message renders the stubbed reply", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello from stub!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("hi bean");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello from stub!");
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
