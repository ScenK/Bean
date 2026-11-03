import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
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

async function openChat(app: ElectronApplication): Promise<Page> {
  const avatar = await app.firstWindow();
  const [chat] = await Promise.all([
    app.waitForEvent("window"),
    avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
  ]);
  await chat.waitForLoadState("domcontentloaded");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))?.isVisible())).toBe(true);
  return chat;
}
const closeChat = (app: ElectronApplication): Promise<void> => app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.close();
});
/** Whether a process whose command line is exactly `cmd` is alive (pgrep exits 1 on none). */
const running = (cmd: string): boolean => {
  try { execFileSync("pgrep", ["-fx", cmd]); return true; } catch { return false; }
};

// #664: a shell keeps its chat mounted across a switch (with a calm >_ marker), and a running command
// joins the window-close card.
test("chat terminal lifecycle: a shell keeps its chat mounted; a running command asks before close, Stop & close kills it", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello from stub!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  const sleeper = `sleep ${100_000 + (process.pid % 50_000)}`;
  try {
    const chat = await openChat(app);
    const shown = chat.locator(".bean-chat:not([hidden])");
    await shown.locator(".bean-input--composer").fill("hi bean");
    await shown.locator(".bean-send").click();
    await expect(shown.locator(".bean-bubble--bean")).toContainText("Hello from stub!");
    await chat.keyboard.press("Control+Backquote");
    const pane = shown.locator(".bean-term");
    await expect.poll(() => chat.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);
    await chat.keyboard.type("echo up-$((2*3))");
    await chat.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("up-6");

    const row = chat.locator(".bean-chat-sidebar-row", { hasText: "hi bean" });
    await expect(row.locator(".bean-chat-sidebar-term")).toHaveAttribute("aria-label", "Terminal open");
    await expect(row.locator(".bean-chat-sidebar-spinner")).toHaveCount(0);
    // Switched away with an idle shell: kept mounted, hidden, marker still there.
    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(shown.locator(".bean-bubble")).toHaveCount(0);
    await expect(chat.locator(".bean-chat")).toHaveCount(2);
    await expect(row.locator(".bean-chat-sidebar-term")).toBeVisible();

    await row.locator(".bean-chat-sidebar-open").click();
    await expect(shown.locator(".bean-bubble--bean")).toContainText("Hello from stub!");
    await expect(pane.locator(".xterm-rows")).toContainText("up-6"); // the same shell, not a fresh one
    await pane.locator(".bean-term-host").click();
    await chat.keyboard.type(sleeper);
    await chat.keyboard.press("Enter");
    await expect.poll(() => running(sleeper)).toBe(true);

    await closeChat(app);
    await expect(chat.locator(".bean-memory-review-title")).toHaveText("sleep is still running in the terminal — closing stops it.");
    await chat.getByRole("button", { name: "Keep working" }).click();
    await expect(chat.locator(".bean-memory-review")).toHaveCount(0);
    expect(running(sleeper)).toBe(true);

    const closed = chat.waitForEvent("close");
    await closeChat(app);
    await chat.getByRole("button", { name: "Stop & close" }).click();
    await closed;
    await expect.poll(() => running(sleeper)).toBe(false);
  } finally {
    try { execFileSync("pkill", ["-fx", sleeper]); } catch { /* already gone */ }
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

test("chat terminal lifecycle: an idle shell closes the window without a card", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const chat = await openChat(app);
    await chat.keyboard.press("Control+Backquote");
    const pane = chat.locator(".bean-chat:not([hidden]) .bean-term");
    await expect.poll(() => chat.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);
    await chat.keyboard.type("echo idle-$((3*3))");
    await chat.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("idle-9");
    const closed = chat.waitForEvent("close");
    await closeChat(app);
    await closed;
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});
