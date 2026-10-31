import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

const QUIET = "Only post when a run needs me";

/** "Only post when a run needs me": shown with a chat sink, round-trips through save, dropped when
 * the last chat sink is unticked, and hidden on a notify-only watch (its fires are always ok). */
test("routines: only-on-problems chat rule round-trips and hides for notify-only watches", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const dir = join(home.homeDir, ".bean", "routines");
  const file = join(dir, "quiet.json");
  await writeFile(file, JSON.stringify({
    name: "quiet", enabled: false, cron: "0 6 * * *", sinks: { chatops: [{ transport: "discord" }] },
    steps: [{ kind: "chat", instruction: "check the build" }],
  }), "utf8");
  await writeFile(join(dir, "feed-watch.json"), JSON.stringify({
    name: "feed-watch", enabled: false, watch: { kind: "feed", url: `${stub.url}/feed.xml` },
    sinks: { chatops: [{ transport: "discord" }] }, steps: [],
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
    await expect(win.locator(".bean-routines-digest-line")).toContainText("Discord DM only when a run needs you");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => (await saved()).chatopsOnlyOnProblems).toBe(true);

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "quiet" }).click();
    await expect(win.getByLabel(QUIET)).toBeChecked();
    await win.getByLabel("Post to Discord (DM)").uncheck();
    await expect(win.getByLabel(QUIET)).toHaveCount(0);
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(async () => {
      const s = await saved();
      return s.chatops === undefined && s.chatopsOnlyOnProblems === undefined;
    }).toBe(true);

    await win.locator(".bean-routines-row", { hasText: "feed-watch" }).click();
    await win.getByRole("button", { name: "Open in editor" }).click(); // never run → review view first
    await expect(win.getByLabel("Post to Discord (DM)")).toBeChecked();
    await expect(win.getByLabel(QUIET)).toHaveCount(0);
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});

/** A DM plus several channels per transport: every entry shows, each row edits only itself, and
 * save trims, drops blank rows and exact duplicates; a Discord `user` entry survives and removes. */
test("routines: chat sinks show and edit a DM plus several channels per transport", async () => {
  const home = await makeBeanHome();
  const file = join(home.homeDir, ".bean", "routines", "multi.json");
  await writeFile(file, JSON.stringify({
    name: "multi", enabled: false, cron: "0 6 * * *",
    sinks: { chatops: [
      { transport: "discord" },
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
    await expect(win.getByLabel("Post to Discord (DM)")).toBeChecked();
    await expect(win.getByLabel("Post to Teams (DM)")).not.toBeChecked();
    const discord = win.getByLabel("Discord channel id");
    await expect(discord).toHaveCount(2);
    await expect(discord.nth(0)).toHaveValue("111");
    await expect(discord.nth(1)).toHaveValue("222");
    await expect(win.getByLabel("Teams conversation id")).toHaveValue("19:abc@thread.v2");
    await expect(win.getByText("DM to user u1")).toBeVisible();
    await expect(win.locator(".bean-routines-digest-line"))
      .toContainText("Discord DM, 2 Discord channels, Discord DM to 1 user, 1 Teams conversation");

    await discord.nth(0).fill("333");
    await win.getByRole("button", { name: "+ Add Teams conversation" }).click();
    await win.getByLabel("Teams conversation id").nth(1).fill(" 19:new@thread.v2 ");
    await win.getByRole("button", { name: "+ Add Discord channel" }).click(); // left blank
    await win.getByRole("button", { name: "+ Add Discord channel" }).click();
    await discord.nth(3).fill("222"); // exact duplicate
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(chatops).toEqual([
      { transport: "discord" },
      { transport: "discord", channel: "333" },
      { transport: "discord", channel: "222" },
      { transport: "discord", user: "u1" },
      { transport: "teams", channel: "19:abc@thread.v2" },
      { transport: "teams", channel: "19:new@thread.v2" },
    ]);

    await win.getByRole("button", { name: "Remove Discord DM to user u1" }).click();
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(chatops).toEqual([
      { transport: "discord" },
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
