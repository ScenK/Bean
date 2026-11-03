import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("chat terminal: folded by default, Control+` opens from the composer and folds from the shell, n stays in the shell", async () => {
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
    const composer = chat.locator(".bean-input--composer");
    await composer.fill("hi bean");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello from stub!");

    const pane = chat.locator(".bean-term");
    const toggle = chat.locator(".bean-chat-term-toggle");
    await expect(pane).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await composer.focus();
    await chat.keyboard.press("Control+Backquote");
    await expect(pane).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(pane.locator(".bean-term-head")).toHaveText("Scratch");
    await expect.poll(() => chat.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);

    // The shell runs: the marker only appears as output, never as the typed command.
    await chat.keyboard.type("echo bean-$((6*7))");
    await chat.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("bean-42");

    // `n` in the shell is a keystroke for the shell, not the window's New chat shortcut.
    await chat.keyboard.type("n");
    await chat.waitForTimeout(300);
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello from stub!");

    await chat.keyboard.press("Control+Backquote");
    await expect(pane).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => chat.evaluate(() => document.activeElement?.classList.contains("bean-input--composer"))).toBe(true);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
