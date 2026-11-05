import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
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
    await expect(pane.locator(".bean-term-project")).toHaveText("Scratch");
    await expect(pane.getByRole("tab")).toHaveCount(1);
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

/** The shown tab's shell has printed its prompt (zsh drops typeahead sent before its line editor starts). */
const promptShown = (pane: ReturnType<Page["locator"]>): Promise<void> =>
  expect(pane.locator("[role=tabpanel]:not([hidden]) .xterm-rows")).toHaveText(/\S/);
/** The shown tab's shell has focus (not a now-hidden tab's). */
const focusedShell = (chat: Page): Promise<boolean> => chat.evaluate(() => {
  const el = document.activeElement;
  return !!el?.classList.contains("xterm-helper-textarea") && !el.closest("[role=tabpanel]")?.hasAttribute("hidden");
});

// #674: up to four tabs per chat, each its own shell and xterm.
test("chat terminal tabs: Cmd+T opens up to four, Cmd+1/2 switch, background output never stalls, exit and × close", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const app = await launchBean({ HOME: home.homeDir });
  const sleeper = `sleep ${150_000 + (process.pid % 50_000)}`;
  const marker = join(tmpdir(), `bean-tab-bg-${process.pid}`);
  rmSync(marker, { force: true });
  try {
    const chat = await openChat(app);
    const pane = chat.locator(".bean-chat:not([hidden]) .bean-term");
    const tabs = pane.getByRole("tab");
    const shownRows = pane.locator("[role=tabpanel]:not([hidden]) .xterm-rows");
    await chat.keyboard.press("Control+Backquote");
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await expect(tabs).toHaveCount(1);
    // Idle: titled by the account's shell (main spawns the passwd shell, not $SHELL).
    await expect(tabs.first()).toHaveAttribute("aria-label", basename(userInfo().shell || "/bin/zsh"));
    await chat.keyboard.type("echo one-$((1+1))");
    await chat.keyboard.press("Enter");
    await expect(shownRows).toContainText("one-2");

    // A background tab keeps writing: tab 1 produces far more than the flow-control watermark
    // while tab 2 is shown, and still reaches its last command.
    await chat.keyboard.type(`sleep 1; yes bean | head -c 600000; touch ${marker}`);
    await chat.keyboard.press("Enter");
    await chat.keyboard.press("Meta+t");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(pane);
    await chat.keyboard.type("echo two-$((2+2))");
    await chat.keyboard.press("Enter");
    await expect(shownRows).toContainText("two-4");
    await expect(shownRows).not.toContainText("one-2");
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    await chat.keyboard.press("Meta+1");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(shownRows).not.toContainText("two-4");
    await chat.keyboard.press("Meta+2");
    await expect(shownRows).toContainText("two-4");

    // The cap: four tabs, then Cmd+T does nothing and "+" reads as disabled.
    const plus = pane.getByRole("button", { name: "New terminal" });
    await expect(plus).toHaveAttribute("aria-disabled", "false");
    await chat.keyboard.press("Meta+t");
    await expect(tabs).toHaveCount(3);
    await chat.keyboard.press("Meta+t");
    await expect(tabs).toHaveCount(4);
    await expect(plus).toHaveAttribute("aria-disabled", "true");
    await expect(plus).toHaveAttribute("title", "4 terminals per chat");
    await chat.keyboard.press("Meta+t");
    await plus.click({ force: true }); // aria-disabled: Playwright would wait for it to enable
    await chat.waitForTimeout(300);
    await expect(tabs).toHaveCount(4);
    await chat.keyboard.press("Meta+4");

    // A non-zero exit keeps its tab, with Restart.
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(pane);
    await chat.keyboard.type("exit 3");
    await chat.keyboard.press("Enter");
    await expect(pane.locator(".bean-term-strip-text")).toHaveText("Shell exited (code 3)");
    await expect(tabs.nth(3)).toHaveAttribute("aria-label", /, exited$/);
    await pane.getByRole("button", { name: "Restart" }).click();
    await expect(pane.locator(".bean-term-strip")).toHaveCount(0);

    // `exit 0` closes its tab (a bare `exit` reuses `$?`, which a fresh HOME's zsh leaves at 1).
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(pane);
    await chat.keyboard.type("exit 0");
    await chat.keyboard.press("Enter");
    await expect(tabs).toHaveCount(3);

    // × on a busy tab asks first; Stop & close kills its command.
    await chat.keyboard.press("Meta+3");
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(pane);
    await chat.keyboard.type(sleeper);
    await chat.keyboard.press("Enter");
    await expect.poll(() => running(sleeper)).toBe(true);
    await expect(tabs.nth(2)).toHaveAttribute("aria-label", "sleep, running");
    await pane.locator(".bean-term-tab--on .bean-term-tab-close").click();
    await expect(pane.locator(".bean-term-strip-text")).toHaveText("sleep is running — closing stops it.");
    await expect(tabs).toHaveCount(3);
    await pane.getByRole("button", { name: "Cancel" }).click();
    await expect(pane.locator(".bean-term-strip")).toHaveCount(0);
    expect(running(sleeper)).toBe(true);
    await pane.locator(".bean-term-tab--on .bean-term-tab-close").click();
    await pane.getByRole("button", { name: "Stop & close" }).click();
    await expect(tabs).toHaveCount(2);
    await expect.poll(() => running(sleeper)).toBe(false);

    // An idle tab's × closes at once; the last tab closing folds the pane.
    await pane.locator(".bean-term-tab--on .bean-term-tab-close").click();
    await expect(tabs).toHaveCount(1);
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await chat.keyboard.type("exit 0");
    await chat.keyboard.press("Enter");
    await expect(pane).toBeHidden();
    await expect(chat.locator(".bean-chat-term-toggle")).toHaveAttribute("aria-expanded", "false");
    // The next unfold starts a fresh tab.
    await chat.keyboard.press("Control+Backquote");
    await expect(tabs).toHaveCount(1);
    await expect.poll(() => focusedShell(chat)).toBe(true);
  } finally {
    try { execFileSync("pkill", ["-fx", sleeper]); } catch { /* already gone */ }
    rmSync(marker, { force: true });
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});

test("chat terminal tabs: a hidden chat with one surviving tab stays mounted after another tab exits", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello from stub!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const chat = await openChat(app);
    const shown = chat.locator(".bean-chat:not([hidden])");
    await shown.locator(".bean-input--composer").fill("hi bean");
    await shown.locator(".bean-send").click();
    await expect(shown.locator(".bean-bubble--bean")).toContainText("Hello from stub!");
    await chat.keyboard.press("Control+Backquote");
    const tabs = shown.locator(".bean-term").getByRole("tab");
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await chat.keyboard.press("Meta+t");
    await expect(tabs).toHaveCount(2);
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(shown.locator(".bean-term"));
    await chat.keyboard.type("exit 0");
    await chat.keyboard.press("Enter");
    await expect(tabs).toHaveCount(1);

    const row = chat.locator(".bean-chat-sidebar-row", { hasText: "hi bean" });
    await expect(row.locator(".bean-chat-sidebar-term")).toBeVisible();
    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(shown.locator(".bean-bubble")).toHaveCount(0);
    await expect(chat.locator(".bean-chat")).toHaveCount(2);
    await expect(row.locator(".bean-chat-sidebar-term")).toBeVisible();
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

/** Whether pid `pid` is alive (signal 0 probes without signalling). */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// #675: the window-close card lists every tab's running command; Stop & close leaves no shell or child.
test("chat terminal tabs: closing the window with two busy tabs names both, Stop & close kills every shell and command", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const app = await launchBean({ HOME: home.homeDir });
  const sleeper = `sleep ${200_000 + (process.pid % 50_000)}`;
  const tailed = join(tmpdir(), `bean-tab-tail-${process.pid}`);
  const tailer = `tail -f ${tailed}`;
  writeFileSync(tailed, "");
  try {
    const chat = await openChat(app);
    const pane = chat.locator(".bean-chat:not([hidden]) .bean-term");
    const tabs = pane.getByRole("tab");
    const shownRows = pane.locator("[role=tabpanel]:not([hidden]) .xterm-rows");
    const shellPid = async (n: number): Promise<number> => {
      await chat.keyboard.type(`echo shell${n}-$$`);
      await chat.keyboard.press("Enter");
      await expect(shownRows).toContainText(new RegExp(`shell${n}-\\d+`));
      return Number(new RegExp(`shell${n}-(\\d+)`).exec(await shownRows.innerText())![1]);
    };

    await chat.keyboard.press("Control+Backquote");
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(pane);
    const pid1 = await shellPid(1);
    await chat.keyboard.type(sleeper);
    await chat.keyboard.press("Enter");
    await chat.keyboard.press("Meta+t");
    await expect(tabs).toHaveCount(2);
    await expect.poll(() => focusedShell(chat)).toBe(true);
    await promptShown(pane);
    const pid2 = await shellPid(2);
    await chat.keyboard.type(tailer);
    await chat.keyboard.press("Enter");
    await expect.poll(() => running(sleeper) && running(tailer)).toBe(true);
    expect(alive(pid1) && alive(pid2)).toBe(true);

    await closeChat(app);
    await expect(chat.locator(".bean-memory-review-title"))
      .toHaveText("sleep and tail are still running in this chat's terminals — closing stops them.");
    const closed = chat.waitForEvent("close");
    await chat.getByRole("button", { name: "Stop & close" }).click();
    await closed;
    await expect.poll(() => [running(sleeper), running(tailer), alive(pid1), alive(pid2)]).toEqual([false, false, false, false]);
  } finally {
    for (const cmd of [sleeper, tailer]) {
      try { execFileSync("pkill", ["-fx", cmd]); } catch { /* already gone */ }
    }
    rmSync(tailed, { force: true });
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});
