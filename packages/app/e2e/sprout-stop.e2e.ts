import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";

// A distinctive sleep; the anchored pattern matches only the step's own process, never a shell
// whose command line happens to contain the text.
const SLEEP = "sleep 4711";
const sleeping = (): boolean => {
  try { return execFileSync("pgrep", ["-f", `^${SLEEP}$`], { encoding: "utf8" }).trim().length > 0; } catch { return false; }
};

/** Stop from the bubble: the run ends "Stopped", the panel stops showing it running, and the
 * command step's process is gone. */
test("sprout stop: the bubble's Stop ends a long command step", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode"] });
  await writeFile(join(home.homeDir, ".bean", "routines", "sleeper.json"), JSON.stringify({
    name: "sleeper", enabled: false, cron: "0 6 * * *", sinks: {},
    steps: [{ kind: "command", command: SLEEP }],
  }), "utf8");
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const avatar = await app.firstWindow();
    await expect(avatar.locator(".bean-orb-body")).toBeAttached();
    await avatar.evaluate(() => { void (window as unknown as { bean: { routinesRunNow: (n: string) => Promise<unknown> } }).bean.routinesRunNow("sleeper"); });

    const bubble = avatar.locator('.bean-bubble[data-id="routine:sleeper"]');
    await expect(bubble).toBeVisible();
    await expect.poll(sleeping).toBe(true);

    const [panel] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
    ]);
    await panel.locator(".bean-routines-row", { hasText: "sleeper" }).click();
    await expect(panel.locator(".bean-routines-stop")).toHaveText("Stop");

    await bubble.click();
    await avatar.locator(".bean-bubble-stop").click();
    await expect(bubble.locator(".bean-bubble-line")).toHaveText("Stopped");
    await expect.poll(sleeping).toBe(false);
    await expect(panel.locator(".bean-routines-stop")).toHaveCount(0, { timeout: 10_000 }); // the panel polls every 5s
    await expect(panel.getByRole("button", { name: "Run now" })).toBeEnabled();
  } finally {
    await app.close();
    await home.cleanup();
  }
});
