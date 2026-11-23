import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dbFile, recordDestination, setAlias } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #686: Settings → ChatOps → Destinations. Naming an unnamed row moves it into its platform
// group; an alias a sprout uses can't be renamed (only moved).
test("settings destinations: name an unnamed row; a referenced alias can't be renamed", async () => {
  const home = await makeBeanHome();
  const beanDir = join(home.homeDir, ".bean");
  const db = dbFile(beanDir);
  recordDestination(db, { surface: "discord", conversationId: "c1", kind: "channel", platformName: "general", parentName: "Guild" });
  recordDestination(db, { surface: "teams", conversationId: "t1", kind: "channel", platformName: "Ops", parentName: "Team" });
  setAlias(db, { surface: "teams", conversationId: "t1" }, "Ops room", () => []);
  // A disabled sprout whose Teams sink names the alias (sink aliases arrive with #687; the
  // store already loads the extra field).
  await writeFile(join(beanDir, "routines", "ops-digest.json"), JSON.stringify({
    name: "ops-digest", enabled: false, cron: "0 9 * * *", steps: [{ kind: "chat", instruction: "summarize" }],
    sinks: { chatops: [{ transport: "teams", alias: "Ops room" }] },
  }), "utf8");
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    // The fixture's review-queue DMs the owner: the #1068 migration turns on the Discord DM copy.
    const homeDms = async (): Promise<unknown> => {
      const c = JSON.parse(await readFile(join(beanDir, "config.json"), "utf8")) as { homeDiscordDm?: boolean; homeTeamsDm?: boolean };
      return [c.homeDiscordDm, c.homeTeamsDm];
    };
    await expect.poll(homeDms).toEqual([true, false]);
    const avatar = await app.firstWindow();
    const [settings] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("settings")),
    ]);
    await settings.waitForLoadState("domcontentloaded");

    await expect(settings.locator(".bean-dest-group", { hasText: "1 unnamed" })).toBeVisible();
    const general = settings.locator('[data-destination="discord:c1"]');
    await general.getByRole("button", { name: "Name" }).click();
    await general.getByRole("textbox", { name: "Destination name" }).fill("Team chat");
    await general.getByRole("textbox", { name: "Destination name" }).press("Enter");

    await expect(settings.locator(".bean-dest-group", { hasText: "unnamed" })).toHaveCount(0);
    const moved = settings.locator('.bean-dest-group:text-is("Discord") ~ [data-destination="discord:c1"]');
    await expect(moved.locator(".bean-dest-title")).toHaveText("Team chat");

    const ops = settings.locator('[data-destination="teams:t1"]');
    await expect(ops.locator(".bean-dest-meta")).toContainText("used by 1 sprout");
    await expect(ops.getByRole("button", { name: "Rename" })).toBeDisabled();
    await expect(ops.locator('span[title*="ops-digest"]').first()).toBeVisible();
    await expect(ops.getByRole("button", { name: "Move" })).toBeEnabled();

    // #1069: each bot group's "DM me sprout posts" toggle saves with Save and reloads; a DM Bean
    // can't reach yet says why.
    const toggle = (n: number) => settings.locator(".bean-settings-home-dm").nth(n).getByRole("checkbox");
    await expect(settings.locator(".bean-settings-home-dm").nth(0)).toContainText("Can't reach your Discord DM yet: discord.json isn't set up");
    await expect(toggle(0)).toBeChecked();
    await toggle(0).uncheck();
    await toggle(1).check();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("button", { name: "Saved ✓" })).toBeVisible();
    await expect.poll(homeDms).toEqual([false, true]);
    await settings.reload();
    await expect(toggle(0)).not.toBeChecked();
    await expect(toggle(1)).toBeChecked();
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
