import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { dbFile, getDesktopChat, listDesktopChats } from "@bean/core";
import { join } from "node:path";

async function openChat(app: ElectronApplication): Promise<Page> {
  const avatar = await app.firstWindow();
  const [chat] = await Promise.all([
    app.waitForEvent("window"),
    avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
  ]);
  await chat.waitForLoadState("domcontentloaded");
  return chat;
}

async function closeChat(app: ElectronApplication, chat: Page): Promise<void> {
  const closed = chat.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("chat"))!.close();
  });
  await closed;
}

// #504: a typed chat is written to desktop_chats and its final state survives the close.
test("chat history: a chat is saved through its close", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello there!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const chat = await openChat(app);
    await chat.locator(".bean-input--composer").fill("hi bean, plan my week");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello there!");
    await closeChat(app, chat);

    const file = dbFile(join(home.homeDir, ".bean"));
    const [row] = listDesktopChats(file);
    expect(row?.title).toBe("hi bean, plan my week");
    const items = JSON.parse(getDesktopChat(file, row!.id)!.itemsJson) as Array<{ kind: string; text?: string }>;
    expect(items.map((it) => it.kind)).toEqual(["user", "reply"]);
    expect(items[1]!.text).toBe("Hello there!");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #504: going off the record removes the saved chat, and nothing more is written — not even at close.
test("chat history: incognito removes the chat and blocks the close write", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "First!" });
  stub.queue({ content: "" }); // the per-turn memory capture: nothing to remember
  stub.queue({ content: "Second!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  const file = dbFile(join(home.homeDir, ".bean"));
  try {
    const chat = await openChat(app);
    await chat.locator(".bean-input--composer").fill("remember nothing");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("First!");
    await expect.poll(() => listDesktopChats(file).length).toBe(1);

    await chat.locator(".bean-chat-incognito").click();
    await expect(chat.locator(".bean-status", { hasText: "Removed from history" })).toBeVisible();
    await expect.poll(() => listDesktopChats(file).length).toBe(0);
    await chat.locator(".bean-chat-incognito").click(); // toggling back off doesn't resume saving
    await chat.locator(".bean-input--composer").fill("still here");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("Second!");
    await closeChat(app, chat);
    expect(listDesktopChats(file)).toEqual([]);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
