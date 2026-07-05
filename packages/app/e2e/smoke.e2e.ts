import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("app boots: avatar window opens with the window.bean IPC bridge", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    await expect
      .poll(() => avatar.evaluate(() => typeof (window as unknown as { bean?: unknown }).bean))
      .toBe("object");
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
