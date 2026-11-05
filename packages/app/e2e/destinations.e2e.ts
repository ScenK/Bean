import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
