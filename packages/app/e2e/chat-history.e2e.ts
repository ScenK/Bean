import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { ConversationCatalog, ConversationStore, dbFile, getDesktopChat, listDesktopChats, saveDesktopChat, speakerLine, starDesktopChat } from "@bean/core";
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
  // Shown on ready-to-show, which can land after the DOM renders — later checks assume it's up.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))?.isVisible())).toBe(true);
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

// A fake `claude` on PATH: waits for `flag` (never written = runs until stopped), then reports one
// stream-json result — a delegate without a real CLI.
async function fakeClaude(flag: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "bean-e2e-bin-"));
  await writeFile(join(bin, "claude"), `#!/bin/sh\nwhile [ ! -f '${flag}' ]; do sleep 0.2; done\necho '{"type":"result","result":"no issues in the PR"}'\n`, "utf8");
  await chmod(join(bin, "claude"), 0o755);
  return bin;
}

// #505/#516/#517: New chat opens empty in place (an unused one leaves no row); a running delegate
// doesn't hold a switch — its chat stays mounted, hidden, its summary lands there, and its row spins
// and then dots. Still the same window throughout.
test("chat history: New chat in place, and a delegate keeps running in a chat switched away from", async () => {
  const flag = join(tmpdir(), `bean-e2e-flag-${process.pid}-${Date.now()}`);
  const bin = await fakeClaude(flag);
  const home = await makeBeanHome({ autoMemory: false, disabledClis: ["codex", "opencode"] });
  const stub = await startStubOpenAI();
  stub.queue({ content: "First!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url, PATH: `${bin}:${process.env.PATH ?? ""}` });
  try {
    const chat = await openChat(app);
    const shown = chat.locator(".bean-chat:not([hidden])");
    await shown.locator(".bean-input--composer").fill("first chat");
    await shown.locator(".bean-send").click();
    await expect(shown.locator(".bean-bubble--bean")).toContainText("First!");
    await watchChat(app);
    const before = await chatState(app);
    expect(before).toMatchObject({ ids: [expect.any(Number)], visible: true });
    const firstRow = chat.locator(".bean-chat-sidebar-row", { hasText: "first chat" });

    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(shown.locator(".bean-bubble")).toHaveCount(0);
    await expect(firstRow).toBeVisible();
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toHaveCount(0);
    // Back and forth past the untouched new chat: it never becomes a row.
    await firstRow.locator(".bean-chat-sidebar-open").click();
    await expect(shown.locator(".bean-bubble--bean")).toContainText("First!");
    await expect(chat.locator(".bean-chat-sidebar-row")).toHaveCount(1);
    // `n` opens a New chat, but only when it isn't typed into the composer.
    await shown.locator(".bean-input--composer").focus();
    await chat.keyboard.press("n");
    await expect(shown.locator(".bean-input--composer")).toHaveValue("n");
    await expect(shown.locator(".bean-bubble--bean")).toContainText("First!");
    await shown.locator(".bean-input--composer").fill("");
    await shown.locator(".bean-input--composer").blur();
    await chat.keyboard.press("n");
    await expect(shown.locator(".bean-bubble")).toHaveCount(0);
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toHaveCount(0);

    // #585: ↵ opens a pending card whose Start takes focus; a held Enter presses nothing, a second ↵ runs it.
    await shown.locator(".bean-input--composer").fill("/review");
    await expect(shown.locator(".bean-slash-menu")).toContainText("review-pr"); // catalogs loaded
    await shown.locator(".bean-input--composer").fill("/review-pr now");
    await chat.keyboard.down("Enter");
    const card = shown.locator(".bean-card", { hasText: "delegate" });
    const start = card.getByRole("button", { name: "Delegate" });
    await expect(start).toBeFocused();
    await chat.keyboard.down("Enter"); // still held: a key-repeat, now on the focused Start
    await chat.keyboard.up("Enter");
    await chat.waitForTimeout(300);
    await expect(start).toBeEnabled(); // still pending
    await expect(card.getByRole("button", { name: /stop|cancel/i })).toHaveCount(0);
    await chat.keyboard.press("Enter");
    await expect(card.getByRole("button", { name: /stop|cancel/i })).toBeVisible();
    await expect(shown.locator(".bean-input--composer")).toBeFocused();
    const reviewRow = chat.locator(".bean-chat-sidebar-row", { hasText: "review-pr" });
    await expect(reviewRow).toBeVisible();

    await firstRow.locator(".bean-chat-sidebar-open").click();
    await expect(chat.locator(".bean-memory-review")).toHaveCount(0);
    await expect(shown.locator(".bean-bubble--bean")).toContainText("First!");
    await expect(reviewRow.locator(".bean-chat-sidebar-spinner")).toBeVisible();

    // The avatar's bubble for that delegate opens its (hidden) chat; then back to the first one.
    const taskBubble = (await app.firstWindow()).locator('.bean-bubble[title="Open chat"]');
    await taskBubble.click();
    await expect(chat.locator(".bean-chat-sidebar-row--active")).toContainText("review-pr");
    await expect(shown.locator(".bean-card", { hasText: "delegate" })).toBeVisible();
    await firstRow.locator(".bean-chat-sidebar-open").click();
    await expect(shown.locator(".bean-bubble--bean")).toContainText("First!");

    // The delegate finishes while its chat is hidden: the loopback summary runs there.
    stub.queue({ content: "Summary: the PR is clean." });
    await writeFile(flag, "", "utf8");
    await expect(reviewRow.locator(".bean-chat-sidebar-dot")).toBeVisible();
    await expect(reviewRow.locator(".bean-chat-sidebar-spinner")).toHaveCount(0);
    await expect(shown).not.toContainText("Summary: the PR is clean.");

    await reviewRow.locator(".bean-chat-sidebar-open").click();
    await expect(shown.locator(".bean-bubble--bean").last()).toContainText("Summary: the PR is clean.");
    await expect(reviewRow.locator(".bean-chat-sidebar-dot")).toHaveCount(0);
    await expect(chat.locator(".bean-chat-sidebar-row")).toHaveCount(2);
    expect(await chatState(app)).toEqual({ ...before, events: [] });
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup(), rm(bin, { recursive: true, force: true }), rm(flag, { force: true })]);
  }
});

// #517: one close card counts the tasks of every chat, shown or hidden, and stops them all.
test("chat history: closing the window counts tasks across chats and stops them all", async () => {
  const flag = join(tmpdir(), `bean-e2e-never-${process.pid}-${Date.now()}`); // never written: runs until stopped
  const bin = await fakeClaude(flag);
  const home = await makeBeanHome({ autoMemory: false, disabledClis: ["codex", "opencode"] });
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url, PATH: `${bin}:${process.env.PATH ?? ""}` });
  try {
    const chat = await openChat(app);
    const shown = chat.locator(".bean-chat:not([hidden])");
    const stopButton = shown.locator(".bean-card", { hasText: "delegate" }).getByRole("button", { name: /stop|cancel/i });
    await shown.locator(".bean-input--composer").fill("/review-pr one");
    await shown.locator(".bean-send").click();
    await shown.locator(".bean-card", { hasText: "delegate" }).getByRole("button", { name: "Delegate" }).click();
    await expect(stopButton).toBeVisible();
    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(shown.locator(".bean-bubble")).toHaveCount(0);
    await shown.locator(".bean-input--composer").fill("/review-pr two");
    await shown.locator(".bean-send").click();
    await shown.locator(".bean-card", { hasText: "delegate" }).getByRole("button", { name: "Delegate" }).click();
    await expect(stopButton).toBeVisible();

    const closed = chat.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.close();
    });
    await expect(chat.locator(".bean-memory-review-title")).toHaveText("Closing stops 2 tasks in 2 chats.");
    await chat.getByRole("button", { name: "Stop & close" }).click();
    await closed;
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup(), rm(bin, { recursive: true, force: true })]);
  }
});

// #530: the owner's Discord DM, from bean.db's catalog + chatops_turns, shows in the sidebar with its
// badge and opens read-only while no bot runs.
test("chat history: a synced Discord DM lists with its badge and opens read-only without a bot", async () => {
  const home = await makeBeanHome();
  const beanDir = join(home.homeDir, ".bean");
  await writeFile(join(beanDir, "discord.json"), JSON.stringify({ botToken: "t", ownerId: "u1" }));
  const file = dbFile(beanDir);
  new ConversationCatalog(file, "discord").upsert({ conversationId: "dm-1", place: { kind: "dm", title: "DM" }, ownerId: "u1" });
  const store = new ConversationStore(file);
  store.append("dm-1", { role: "user", content: speakerLine("Scen", "sent from my phone") });
  store.append("dm-1", { role: "assistant", content: "Got it on Discord." });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const chat = await openChat(app);
    const row = chat.locator(".bean-chat-sidebar-row", { hasText: "DM" });
    await expect(row.locator(".bean-chat-sidebar-badge")).toHaveText("Discord");
    await expect(row.locator(".bean-chat-sidebar-row-delete")).toHaveCount(0);
    await row.locator(".bean-chat-sidebar-open").click();
    const synced = chat.locator(".bean-chat--synced");
    await expect(synced.locator(".bean-bubble--user")).toHaveText(/sent from my phone/);
    await expect(synced.locator(".bean-bubble--bean")).toContainText("Got it on Discord.");
    await expect(synced.locator(".bean-input--composer")).toBeDisabled();
    await expect(synced).toContainText("The Discord bot isn't running");
    await expect(synced).toContainText("Cards, approvals and memory receipts stay in Discord.");
    await expect(chat.locator(".bean-chat:not([hidden]):not(.bean-chat--synced)")).toHaveCount(0);
    expect(listDesktopChats(file)).toEqual([]);
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});

// #753: a starred chat sits in Starred with no ✕, outlives the 90-day prune, and unstarring a
// thread past the cutoff lists it under Today.
test("chat history: star pins a chat past the prune; unstar returns it to Today", async () => {
  const home = await makeBeanHome();
  const file = dbFile(join(home.homeDir, ".bean"));
  const id = "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const seed = (at: Date): void => saveDesktopChat(file, { id, title: "keep me", itemsJson: JSON.stringify([{ kind: "user", id: "a", text: "keep me" }]) }, at);
  seed(new Date());
  const app = await launchBean({ HOME: home.homeDir });
  try {
    let chat = await openChat(app);
    const row = (c: Page) => c.locator(`[data-row="${id}"]`);
    const firstUnder = (c: Page, label: string) => c.locator(`.bean-chat-sidebar-group:has-text("${label}") + [data-row]`);
    await row(chat).locator(".bean-chat-sidebar-row-star").click();
    await expect(firstUnder(chat, "Starred")).toHaveAttribute("data-row", id);
    await expect(row(chat).locator(".bean-chat-sidebar-row-star")).toHaveAttribute("aria-pressed", "true");
    await expect(row(chat).locator(".bean-chat-sidebar-row-delete")).toHaveCount(0);
    await expect(chat.locator(".bean-chat-sidebar-head")).toHaveText("All chats · 1");
    await closeChat(app, chat);
    seed(new Date(Date.now() - 100 * 86_400_000)); // the save upsert keeps the star
    chat = await openChat(app);
    await expect(firstUnder(chat, "Starred")).toHaveAttribute("data-row", id);
    await row(chat).locator(".bean-chat-sidebar-row-star").click();
    await expect(firstUnder(chat, "Today")).toHaveAttribute("data-row", id);
    await expect(chat.locator(".bean-chat-sidebar-group", { hasText: "Starred" })).toHaveCount(0);
    await expect(row(chat).locator(".bean-chat-sidebar-row-delete")).toHaveCount(1);
    expect(listDesktopChats(file)).toMatchObject([{ id, starred: false }]);
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});

// #762: the open chat renamed by keyboard alone (focus a row, F2, type, Enter) keeps the new title
// through its next saves and the close; a closed chat renames from ✎ too.
test("chat history: rename a chat inline in the sidebar", async () => {
  const home = await makeBeanHome();
  const file = dbFile(join(home.homeDir, ".bean"));
  const closedId = "8b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e";
  saveDesktopChat(file, { id: closedId, title: "old chat", itemsJson: JSON.stringify([{ kind: "user", id: "a", text: "old chat" }]) });
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello there!" });
  // Turn 1's per-turn memory capture takes one of these, whichever order it lands in.
  stub.queue({ content: "Again!" });
  stub.queue({ content: "Again!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const chat = await openChat(app);
    const composer = chat.locator(".bean-chat:not([hidden]) .bean-input--composer");
    await composer.fill("plan my week");
    await chat.locator(".bean-chat:not([hidden]) .bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello there!");
    const active = chat.locator(".bean-chat-sidebar-row--active");
    await expect(active.locator(".bean-chat-sidebar-title")).toHaveText("plan my week");
    await active.locator(".bean-chat-sidebar-open").focus();
    await chat.keyboard.press("F2");
    const input = chat.locator(".bean-chat-sidebar-rename");
    await expect(input).toBeFocused();
    await chat.keyboard.type("Week plan");
    await chat.keyboard.press("Enter");
    await expect(active.locator(".bean-chat-sidebar-title")).toHaveText("Week plan");
    await expect(active.locator(".bean-chat-sidebar-row-rename")).toBeFocused();
    // The next save (the open chat re-sends its title) keeps the rename.
    await composer.fill("and next week?");
    await chat.locator(".bean-chat:not([hidden]) .bean-send").click();
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("Again!");
    await expect(active.locator(".bean-chat-sidebar-title")).toHaveText("Week plan");
    // A closed chat: ✎, then Escape cancels and an edit saves.
    const closed = chat.locator(`[data-row="${closedId}"]`);
    await closed.hover();
    await closed.locator(".bean-chat-sidebar-row-rename").click();
    await chat.keyboard.type("nope");
    await chat.keyboard.press("Escape");
    await expect(closed.locator(".bean-chat-sidebar-title")).toHaveText("old chat");
    await closed.locator(".bean-chat-sidebar-row-rename").click();
    await chat.keyboard.type("Renamed old");
    await chat.keyboard.press("Enter");
    await expect(closed.locator(".bean-chat-sidebar-title")).toHaveText("Renamed old");
    await closeChat(app, chat);
    expect(Object.fromEntries(listDesktopChats(file).map((t) => [t.title, t.id]))).toMatchObject({ "Week plan": expect.any(String), "Renamed old": closedId });
    const again = await openChat(app);
    await expect(again.locator(`[data-row="${closedId}"] .bean-chat-sidebar-title`)).toHaveText("Renamed old");
    await expect(again.locator(".bean-chat-sidebar-title", { hasText: "Week plan" })).toHaveCount(1);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #764: starred chats grouped from the row's Group menu, folded by keyboard (the fold survives a
// restart), renamed with F2; unstarring a member sends it back to its date section and the group
// goes once its last member leaves.
test("chat history: foldable named groups inside Starred", async () => {
  const home = await makeBeanHome();
  const file = dbFile(join(home.homeDir, ".bean"));
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const [a, b] = ["9c4d5e6f-7081-4c9d-8e0f-2a3b4c5d6e7f", "0d5e6f70-8192-4dae-9f10-3b4c5d6e7f80"];
  for (const [id, title] of [[a, "alpha"], [b, "beta"]] as const) {
    saveDesktopChat(file, { id, title, itemsJson: JSON.stringify([{ kind: "user", id: "a", text: title }]) });
    starDesktopChat(file, id, true);
  }
  const env = { HOME: home.homeDir };
  try {
    const app = await launchBean(env, userDataDir);
    try {
      const chat = await openChat(app);
      const row = (id: string) => chat.locator(`[data-row="${id}"]`);
      const header = chat.locator(".bean-chat-sidebar-group--named");
      await row(a).locator(".bean-chat-sidebar-row-group").selectOption({ label: "New group…" });
      await expect(chat.locator(".bean-chat-sidebar-rename")).toBeFocused();
      await chat.keyboard.type("Work");
      await chat.keyboard.press("Enter");
      await expect(header).toHaveText(/Work\s*1/);
      await expect(row(a).locator(".bean-chat-sidebar-row-group")).toBeFocused();
      await row(b).locator(".bean-chat-sidebar-row-group").selectOption("Work");
      await expect(header).toHaveText(/Work\s*2/);
      // Fold by keyboard: members hide, the count stays.
      await header.focus();
      await chat.keyboard.press("Enter");
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(chat.locator("[data-row]")).toHaveCount(0);
      // F2 renames the folded group; it stays folded.
      await chat.keyboard.press("F2");
      await expect(chat.locator(".bean-chat-sidebar-rename")).toBeFocused();
      await chat.keyboard.press("Meta+A");
      await chat.keyboard.type("Projects");
      await chat.keyboard.press("Enter");
      await expect(header).toHaveText(/Projects\s*2/);
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(header).toBeFocused();
      expect(listDesktopChats(file).map((t) => t.groupName)).toEqual(["Projects", "Projects"]);
    } finally {
      await app.close();
    }
    const restarted = await launchBean(env, userDataDir);
    try {
      const chat = await openChat(restarted);
      const row = (id: string) => chat.locator(`[data-row="${id}"]`);
      const header = chat.locator(".bean-chat-sidebar-group--named");
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await row(a).hover();
      await row(a).locator(".bean-chat-sidebar-row-star").click();
      await expect(chat.locator('.bean-chat-sidebar-group:has-text("Today") + [data-row]')).toHaveAttribute("data-row", a);
      await expect(header).toHaveText(/Projects\s*1/);
      await row(b).locator(".bean-chat-sidebar-row-group").selectOption({ label: "Remove from group" });
      await expect(header).toHaveCount(0);
      await expect(chat.locator('.bean-chat-sidebar-group:has-text("Starred") + [data-row]')).toHaveAttribute("data-row", b);
      expect(Object.fromEntries(listDesktopChats(file).map((t) => [t.id, [t.starred, t.groupName]]))).toEqual({ [a]: [false, null], [b]: [true, null] });
    } finally {
      await restarted.close();
    }
  } finally {
    await Promise.allSettled([home.cleanup(), rm(userDataDir, { recursive: true, force: true })]);
  }
});

// #601: after the bot's `/new`, the archive joins the sidebar on its push (no reload), reads
// `· archived` and stays read-only even with history; the live row shows the fresh start.
test("chat history: a /new archive lists on push, read-only, and the live row says where it went", async () => {
  const home = await makeBeanHome();
  const beanDir = join(home.homeDir, ".bean");
  await writeFile(join(beanDir, "discord.json"), JSON.stringify({ botToken: "t", ownerId: "u1" }));
  const file = dbFile(beanDir);
  new ConversationCatalog(file, "discord").upsert({ conversationId: "dm-1", place: { kind: "dm", title: "DM" }, ownerId: "u1" });
  const store = new ConversationStore(file);
  store.append("dm-1", { role: "user", content: speakerLine("Scen", "before the fresh start") });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const chat = await openChat(app);
    const rows = chat.locator(".bean-chat-sidebar-row", { hasText: "DM" });
    await expect(rows).toHaveCount(1);
    expect(store.clear("dm-1")).toBeTruthy();
    // Stands in for the bot's history-change activity, which main forwards as this push.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!
        .webContents.send("bean:synced-chat-event", { surface: "discord", conversationId: "dm-1" });
    });
    const archived = chat.locator(".bean-chat-sidebar-row", { hasText: "DM · archived" });
    await expect(archived).toHaveCount(1);
    await expect(rows).toHaveCount(2);

    await archived.locator(".bean-chat-sidebar-open").click();
    const synced = chat.locator(".bean-chat--synced");
    await expect(synced.locator(".bean-bubble--user")).toHaveText(/before the fresh start/);
    await expect(synced.locator(".bean-input--composer")).toBeDisabled();
    await expect(synced.locator(".bean-input--composer")).toHaveAttribute("placeholder", "Archived after /new — read only");
    await expect(synced.getByRole("button", { name: "Continue live" })).toHaveCount(0);

    await rows.filter({ hasNotText: "archived" }).locator(".bean-chat-sidebar-open").click();
    await expect(synced).toContainText("Fresh start — the earlier conversation is in the archived entry.");
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});

// #697: Continue in Discord needs the app-spawned Discord bot — disabled (with the reason) without it.
test("continue in Discord: the button is disabled while no Discord bot runs", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello there!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const chat = await openChat(app);
    await chat.locator(".bean-input--composer").fill("plan my week");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello there!");
    const button = chat.locator(".bean-chat:not([hidden]) .bean-chat-continue");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "Start the Discord bot in Settings first.");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #697: a continued chat restores read-only with Open thread, which shows the thread's synced view —
// and a synced chat has no Continue in Discord button.
test("continue in Discord: a continued chat is read-only and Open thread shows the synced thread", async () => {
  const home = await makeBeanHome();
  const beanDir = join(home.homeDir, ".bean");
  await writeFile(join(beanDir, "discord.json"), JSON.stringify({ botToken: "t", ownerId: "u1" }));
  const file = dbFile(beanDir);
  new ConversationCatalog(file, "discord").upsert({ conversationId: "th-1", place: { kind: "thread", title: "Week plan" }, ownerId: "u1" });
  new ConversationStore(file).append("th-1", { role: "assistant", content: "Picked up from the desktop." });
  saveDesktopChat(file, {
    id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", title: "plan my week",
    itemsJson: JSON.stringify([
      { kind: "user", id: "a", text: "plan my week" },
      { kind: "reply", id: "b", text: "Sure" },
      { kind: "continued", id: "c", surface: "discord", conversationId: "th-1", title: "Week plan" },
    ]),
  });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const chat = await openChat(app);
    await chat.locator(".bean-chat-sidebar-row", { hasText: "plan my week" }).locator(".bean-chat-sidebar-open").click();
    const shown = chat.locator(".bean-chat:not([hidden]):not(.bean-chat--synced)");
    await expect(shown.locator(".bean-chat-continued")).toContainText("This chat continues in Discord");
    await expect(shown.locator(".bean-input--composer")).toHaveCount(0);
    await expect(shown.locator(".bean-chat-continue")).toBeDisabled();
    await shown.locator(".bean-chat-continued").getByRole("button", { name: "Open thread" }).click();
    const synced = chat.locator(".bean-chat--synced");
    await expect(synced.locator(".bean-bubble--bean")).toContainText("Picked up from the desktop.");
    await expect(synced.locator(".bean-chat-continue")).toHaveCount(0);
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});
