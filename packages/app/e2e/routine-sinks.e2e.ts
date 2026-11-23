import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

const QUIET = "Only message Discord and Teams when a run needs me";
const BRIEF = "Sum up as a short brief";

/** Only-on-problems: shown with a chat sink, round-trips through save, dropped when the last chat
 * sink is unticked, and hidden on a notify-only watch (its fires are always ok). A DM-only sprout
 * folded into Home (#1068) keeps it through an editor save: it mutes Home's DM copy (#1069). */
test("routines: only-on-problems chat rule round-trips and hides for notify-only watches", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const dir = join(home.homeDir, ".bean", "routines");
  const file = join(dir, "quiet.json");
  await writeFile(file, JSON.stringify({
    name: "quiet", enabled: false, cron: "0 6 * * *", sinks: { chatops: [{ transport: "discord", channel: "111" }] },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  await writeFile(join(dir, "feed-watch.json"), JSON.stringify({
    name: "feed-watch", enabled: false, watch: { kind: "feed", url: `${stub.url}/feed.xml` },
    sinks: { chatops: [{ transport: "discord", channel: "111" }] }, steps: [],
  }), "utf8");
  const dmOnly = join(dir, "dm-only.json");
  await writeFile(dmOnly, JSON.stringify({
    name: "dm-only", enabled: false, cron: "0 7 * * *", sinks: { chatops: [{ transport: "discord" }], chatopsOnlyOnProblems: true },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  const saved = async (): Promise<{ chatops?: unknown[]; chatopsOnlyOnProblems?: boolean }> =>
    (JSON.parse(await readFile(file, "utf8")) as { sinks: { chatops?: unknown[]; chatopsOnlyOnProblems?: boolean } }).sinks;

  const openPanel = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    return win;
  };

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const win = await openPanel(app);
    await win.locator(".bean-routines-row", { hasText: "quiet" }).click();
    const quiet = win.getByLabel(QUIET);
    await expect(quiet).not.toBeChecked();
    await quiet.check();
    await expect(win.locator(".bean-routines-digest-line")).toContainText("1 Discord channel only when a run needs you");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => (await saved()).chatopsOnlyOnProblems).toBe(true);
    // Save confirms itself like Settings' Save, and reverts once the draft is edited again.
    await expect(win.getByRole("button", { name: "Saved ✓" })).toBeVisible();
    await quiet.uncheck();
    await expect(win.getByRole("button", { name: "Save sprout" })).toBeVisible();
    await quiet.check();

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "quiet" }).click();
    await expect(win.getByLabel(QUIET)).toBeChecked();
    await win.getByRole("button", { name: "Remove Discord channel" }).click();
    await expect(win.getByLabel(QUIET)).toHaveCount(0);
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => {
      const s = await saved();
      return s.chatops === undefined && s.chatopsOnlyOnProblems === undefined;
    }).toBe(true);

    await win.locator(".bean-routines-row", { hasText: "dm-only" }).click();
    await expect(win.getByLabel("Post to your chat with Bean", { exact: true })).toBeChecked();
    await expect(win.getByLabel(QUIET)).toBeChecked();
    await expect(win.getByText("Post to Discord (DM)")).toHaveCount(0); // owner DMs are Settings' toggle now
    await win.getByLabel("Drop the post to your chat with Bean if unread after this many minutes").fill("60");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => (JSON.parse(await readFile(dmOnly, "utf8")) as { sinks: unknown }).sinks)
      .toEqual({ home: { ttlMinutes: 60 }, chatopsOnlyOnProblems: true });

    await win.locator(".bean-routines-row", { hasText: "feed-watch" }).click();
    await win.getByRole("button", { name: "Open in editor" }).click(); // never run → review view first
    await expect(win.getByLabel("Discord channel id")).toHaveValue("111");
    await expect(win.getByLabel(QUIET)).toHaveCount(0);
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** "Sum up as a short brief": checked by default with a chat sink; unchecking saves
 * `chatopsVerbatim: true`, re-checking removes it, and dropping the last chat sink drops it too. */
test("routines: chat brief switch round-trips chatopsVerbatim", async () => {
  const home = await makeBeanHome();
  const dir = join(home.homeDir, ".bean", "routines");
  const file = join(dir, "brief.json");
  await writeFile(file, JSON.stringify({
    name: "brief", enabled: false, cron: "0 6 * * *", sinks: { chatops: [{ transport: "discord", channel: "111" }], note: true },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  await writeFile(join(dir, "plain.json"), JSON.stringify({
    name: "plain", enabled: false, cron: "0 6 * * *", sinks: { note: true },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  const saved = async (): Promise<Record<string, unknown>> =>
    (JSON.parse(await readFile(file, "utf8")) as { sinks: Record<string, unknown> }).sinks;

  const app = await launchBean({ HOME: home.homeDir });
  try {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "plain" }).click();
    await expect(win.getByLabel(BRIEF)).toHaveCount(0);

    await win.locator(".bean-routines-row", { hasText: "brief" }).click();
    const footer = win.locator(".bean-routines-digest-line");
    await expect(win.getByLabel(BRIEF)).toBeChecked();
    await expect(footer).toContainText("Posts a brief to 1 Discord channel and a digest to your Daily Dashboard");
    await win.getByLabel(BRIEF).uncheck();
    await expect(footer).toContainText("Posts a digest to your Daily Dashboard, 1 Discord channel");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => (await saved()).chatopsVerbatim).toBe(true);

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "brief" }).click();
    await expect(win.getByLabel(BRIEF)).not.toBeChecked();
    await win.getByLabel(BRIEF).check();
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => "chatopsVerbatim" in (await saved())).toBe(false);

    await win.getByLabel(BRIEF).uncheck();
    await win.getByRole("button", { name: "Remove Discord channel" }).click();
    await expect(win.getByLabel(BRIEF)).toHaveCount(0);
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(saved).toEqual({ note: true });
  } finally {
    await app.close();
    await home.cleanup();
  }
});

/** Several channels per transport: every entry shows, each row edits only itself, and save trims,
 * drops blank rows and exact duplicates; a Discord `user` entry survives and removes. (The owner's
 * DM folds into Home on load since #1068.) */
test("routines: chat sinks show and edit several channels per transport", async () => {
  const home = await makeBeanHome();
  const file = join(home.homeDir, ".bean", "routines", "multi.json");
  await writeFile(file, JSON.stringify({
    name: "multi", enabled: false, cron: "0 6 * * *",
    sinks: { chatops: [
      { transport: "discord", channel: "111" },
      { transport: "discord", channel: "222" },
      { transport: "discord", user: "u1" },
      { transport: "teams", channel: "19:abc@thread.v2" },
    ] },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  const chatops = async (): Promise<unknown> =>
    (JSON.parse(await readFile(file, "utf8")) as { sinks: { chatops?: unknown } }).sinks.chatops;

  const app = await launchBean({ HOME: home.homeDir });
  try {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "multi" }).click();
    const discord = win.getByLabel("Discord channel id");
    await expect(discord).toHaveCount(2);
    await expect(discord.nth(0)).toHaveValue("111");
    await expect(discord.nth(1)).toHaveValue("222");
    await expect(win.getByLabel("Teams conversation id")).toHaveValue("19:abc@thread.v2");
    await expect(win.getByText("DM to user u1")).toBeVisible();
    await expect(win.locator(".bean-routines-digest-line"))
      .toContainText("2 Discord channels, Discord DM to 1 user, 1 Teams conversation");

    await discord.nth(0).fill("333");
    await win.getByRole("button", { name: "+ Add Teams conversation" }).click();
    await win.getByLabel("Teams conversation id").nth(1).fill(" 19:new@thread.v2 ");
    await win.getByRole("button", { name: "+ Add Discord channel" }).click(); // left blank
    await win.getByRole("button", { name: "+ Add Discord channel" }).click();
    await discord.nth(3).fill("222"); // exact duplicate
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(chatops).toEqual([
      { transport: "discord", channel: "333" },
      { transport: "discord", channel: "222" },
      { transport: "discord", user: "u1" },
      { transport: "teams", channel: "19:abc@thread.v2" },
      { transport: "teams", channel: "19:new@thread.v2" },
    ]);

    await win.getByRole("button", { name: "Remove Discord DM to user u1" }).click();
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(chatops).toEqual([
      { transport: "discord", channel: "333" },
      { transport: "discord", channel: "222" },
      { transport: "teams", channel: "19:abc@thread.v2" },
      { transport: "teams", channel: "19:new@thread.v2" },
    ]);
  } finally {
    await app.close();
    await home.cleanup();
  }
});

/** "Post to your chat with Bean" (#962, #1001): ticking saves `sinks.home`, the minutes field sets `ttlMinutes`
 * (an invalid value is refused with a message, the file untouched), the enabled and todo-driven
 * flips keep it, and unticking removes it while the other sinks stay. */
test("routines: Post to Home chat round-trips sinks.home and its unread timeout", async () => {
  const home = await makeBeanHome();
  const file = join(home.homeDir, ".bean", "routines", "homey.json");
  await writeFile(file, JSON.stringify({
    name: "homey", enabled: false, cron: "0 6 * * *", sinks: { note: true },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  const saved = async (): Promise<Record<string, unknown>> =>
    (JSON.parse(await readFile(file, "utf8")) as { sinks: Record<string, unknown> }).sinks;
  const ttl = "Drop the post to your chat with Bean if unread after this many minutes";

  const app = await launchBean({ HOME: home.homeDir });
  try {
    // The fixture's review-queue DMs the owner: the #1068 migration turns on the Discord DM copy.
    await expect.poll(async () => (JSON.parse(await readFile(join(home.homeDir, ".bean", "config.json"), "utf8")) as { homeDiscordDm?: boolean }).homeDiscordDm).toBe(true);
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await win.locator(".bean-routines-row", { hasText: "homey" }).click();
    await expect(win.getByLabel(ttl)).toHaveCount(0);
    await win.getByLabel("Post to your chat with Bean", { exact: true }).check();
    await expect(win.locator(".bean-routines-home-dms")).toHaveText("Also sent to your Discord DM (Settings › Chat bots)");
    await expect(win.locator(".bean-routines-digest-line")).toContainText("Posts a brief to your chat with Bean and your Discord DM and a digest to your Daily Dashboard");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(saved).toEqual({ note: true, home: {} });
    // Edit only once the save has settled, or its late "Saved ✓" lands on the edited draft.
    await expect(win.getByRole("button", { name: "Saved ✓" })).toBeVisible();

    await win.getByLabel(ttl).fill("0");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect(win.locator(".bean-status--error")).toContainText("ttlMinutes must be a whole number");
    expect(await saved()).toEqual({ note: true, home: {} });

    await win.getByLabel(ttl).fill("45");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(saved).toEqual({ note: true, home: { ttlMinutes: 45 } });
    await expect(win.getByRole("button", { name: "Saved ✓" })).toBeVisible();

    // Malformed keyboard input ("-" reads as "" with badInput) is refused, never saved as "keep".
    await win.getByLabel(ttl).selectText();
    await win.keyboard.type("-");
    await expect(win.getByLabel(ttl)).toBeFocused();
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect(win.locator(".bean-status--error")).toContainText("ttlMinutes must be a whole number");
    expect(await saved()).toEqual({ note: true, home: { ttlMinutes: 45 } });
    await win.getByLabel(ttl).fill("45");

    await win.getByRole("switch").click();
    await expect.poll(async () => (JSON.parse(await readFile(file, "utf8")) as { enabled: boolean }).enabled).toBe(true);
    await win.getByRole("button", { name: "⚡ Todo-driven" }).click();
    await expect.poll(async () => (JSON.parse(await readFile(file, "utf8")) as { todoDriven?: boolean }).todoDriven).toBe(true);
    expect(await saved()).toEqual({ note: true, home: { ttlMinutes: 45 } });

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "homey" }).click();
    await expect(win.getByLabel(ttl)).toHaveValue("45");
    await win.getByLabel("Post to your chat with Bean", { exact: true }).uncheck();
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(saved).toEqual({ note: true });
  } finally {
    await app.close();
    await home.cleanup();
  }
});
