import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { dbFile, getDesktopChat, listDesktopChats } from "@bean/core";
import { join } from "node:path";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

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
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.close();
  });
  await closed;
}

// The chat BrowserWindow, and every close/hide it emits from here on (a switch must emit none).
const watchChat = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!;
  const g = globalThis as unknown as { chatEvents: string[] };
  g.chatEvents = [];
  w.on("close", () => g.chatEvents.push("close"));
  w.on("hide", () => g.chatEvents.push("hide"));
});
const chatState = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const all = BrowserWindow.getAllWindows();
  const chats = all.filter((w) => w.webContents.getURL().endsWith("/chat.html"));
  return {
    ids: chats.map((w) => w.id), count: all.length, visible: chats.every((w) => w.isVisible()),
    events: (globalThis as unknown as { chatEvents: string[] }).chatEvents,
  };
});

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

// #505/#516: a saved chat survives a relaunch, and picking it in the sidebar restores it inside the
// same window — no close, no hide, no second window.
test("chat history: relaunch, pick the saved chat, transcript restored in the same window", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello there!" });
  const env = { HOME: home.homeDir, OPENAI_BASE_URL: stub.url };
  let app = await launchBean(env);
  try {
    const first = await openChat(app);
    await first.locator(".bean-input--composer").fill("hi bean, plan my week");
    await first.locator(".bean-send").click();
    await expect(first.locator(".bean-bubble--bean")).toContainText("Hello there!");
    await closeChat(app, first);
    await app.close();

    app = await launchBean(env);
    const chat = await openChat(app);
    const row = chat.locator(".bean-chat-sidebar-row", { hasText: "hi bean, plan my week" });
    await expect(row).toBeVisible();
    await expect(chat.locator(".bean-bubble")).toHaveCount(0);
    await watchChat(app);
    const before = await chatState(app);
    await row.locator(".bean-chat-sidebar-open").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello there!");
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toContainText("hi bean, plan my week");
    await expect(chat.locator(".bean-chat-sidebar-row--active .bean-chat-sidebar-row-delete")).toHaveCount(0);
    await expect(chat.locator(".bean-input--composer")).toBeFocused();
    expect(before).toMatchObject({ ids: [expect.any(Number)], visible: true });
    expect(await chatState(app)).toEqual({ ...before, events: [] });
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #505/#516: New chat opens empty in place (an unused one leaves no row); a running delegate holds a
// switch on the Keep/Stop card, and Stop & switch then switches — still the same window.
test("chat history: New chat in place, and a running delegate holds a switch until Stop & switch", async () => {
  // A fake `claude` that just keeps running — the delegate stays "running" without a real CLI.
  const bin = await mkdtemp(join(tmpdir(), "bean-e2e-bin-"));
  await writeFile(join(bin, "claude"), "#!/bin/sh\nsleep 120\n", "utf8");
  await chmod(join(bin, "claude"), 0o755);
  const home = await makeBeanHome({ autoMemory: false, disabledClis: ["codex", "opencode"] });
  const stub = await startStubOpenAI();
  stub.queue({ content: "First!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url, PATH: `${bin}:${process.env.PATH ?? ""}` });
  try {
    const chat = await openChat(app);
    await chat.locator(".bean-input--composer").fill("first chat");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("First!");
    await watchChat(app);
    const before = await chatState(app);
    expect(before).toMatchObject({ ids: [expect.any(Number)], visible: true });
    const firstRow = chat.locator(".bean-chat-sidebar-row", { hasText: "first chat" });

    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(chat.locator(".bean-bubble")).toHaveCount(0);
    await expect(firstRow).toBeVisible();
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toHaveCount(0);
    // Back and forth past the untouched new chat: it never becomes a row.
    await firstRow.locator(".bean-chat-sidebar-open").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("First!");
    await expect(chat.locator(".bean-chat-sidebar-row")).toHaveCount(1);
    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(chat.locator(".bean-bubble")).toHaveCount(0);

    await chat.locator(".bean-input--composer").fill("/review-pr now");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-card", { hasText: "delegate" }).getByRole("button", { name: /stop|cancel/i })).toBeVisible();

    await firstRow.locator(".bean-chat-sidebar-open").click();
    await expect(chat.locator(".bean-memory-review-title")).toContainText("Switching chats stops");
    await chat.getByRole("button", { name: "Keep working" }).click();
    await expect(chat.locator(".bean-memory-review")).toHaveCount(0);
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toContainText("now"); // still this chat

    await firstRow.locator(".bean-chat-sidebar-open").click();
    await chat.getByRole("button", { name: "Stop & switch" }).click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("First!");
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toContainText("first chat");
    await expect(chat.locator(".bean-chat-sidebar-row")).toHaveCount(2);
    expect(await chatState(app)).toEqual({ ...before, events: [] });
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup(), rm(bin, { recursive: true, force: true })]);
  }
});
