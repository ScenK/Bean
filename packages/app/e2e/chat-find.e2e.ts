import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { join } from "node:path";
import { dbFile, saveDesktopChat } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";

async function openChat(app: ElectronApplication): Promise<Page> {
  const avatar = await app.firstWindow();
  const [chat] = await Promise.all([
    app.waitForEvent("window"),
    avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
  ]) as [Page, unknown];
  await chat.waitForLoadState("domcontentloaded");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))?.isVisible())).toBe(true);
  return chat;
}

// #901: Cmd+F from the composer finds text in the shown chat's messages only (not the sidebar title or
// the composer draft), Enter / Shift+Enter step through and scroll, Escape closes and restores focus.
test("chat find: Cmd+F counts, steps and scrolls through the shown chat's matches, Escape closes", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const id = "5c6d7e8f-9012-4a3b-8c4d-5e6f7a8b9c0d";
  const items = Array.from({ length: 30 }, (_, i) => [
    { kind: "user", id: `u${i}`, text: `ask ${i}` },
    { kind: "reply", id: `r${i}`, text: `Here is the needle number ${i}.\n\nAnother paragraph of filler text.` },
  ]).flat();
  saveDesktopChat(dbFile(join(home.homeDir, ".bean")), { id, title: "needle chat", itemsJson: JSON.stringify(items) });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const chat = await openChat(app);
    await chat.locator(`[data-row="${id}"]`).click();
    await expect(chat.locator(".bean-chat:not([hidden]) .bean-chat-scroll")).toContainText("needle number 29");
    const composer = chat.locator(".bean-chat:not([hidden]) .bean-input--composer");
    await composer.fill("needle draft");
    await composer.focus();

    await chat.keyboard.press("Meta+f");
    const input = chat.getByRole("textbox", { name: "Find in chat" });
    await expect(input).toBeFocused();
    await input.fill("NEEDLE");
    const status = chat.locator(".bean-find [role=status]");
    await expect(status).toHaveText(/^\d+ of 30$/);
    const current = () => chat.evaluate(() => [...(CSS.highlights.get("bean-find-current") ?? [])].map((r) => (r as Range).toString()));
    expect(await current()).toEqual(["needle"]);
    expect(await chat.evaluate(() => CSS.highlights.get("bean-find")?.size)).toBe(29);

    // Step to the first match, then wrap back to the last: the list scrolls between them.
    const scrollTop = () => chat.locator(".bean-chat:not([hidden]) .bean-chat-scroll").evaluate((el) => el.scrollTop);
    for (let i = 0; i < 30 && (await status.textContent()) !== "1 of 30"; i++) await input.press("Enter");
    await expect(status).toHaveText("1 of 30");
    const top = await scrollTop();
    await input.press("Shift+Enter");
    await expect(status).toHaveText("30 of 30");
    await expect.poll(scrollTop).toBeGreaterThan(top + 200);
    // Only the list scrolls: centering the last match must not push the window's layout up (blank below).
    expect(await chat.locator(".bean-chat:not([hidden]) .bean-chat-scroll").evaluate((el) => {
      const shifted: string[] = [];
      for (let a = el.parentElement; a; a = a.parentElement) if (a.scrollTop) shifted.push(a.className || a.tagName);
      return shifted;
    })).toEqual([]);

    await input.fill("no such thing");
    await expect(status).toHaveText("No matches");

    await input.press("Escape");
    await expect(chat.locator(".bean-find")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("needle draft");
    expect(await chat.evaluate(() => [...CSS.highlights.keys()].map((k) => `${k}:${CSS.highlights.get(k)!.size}`))).toEqual([]);
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});
