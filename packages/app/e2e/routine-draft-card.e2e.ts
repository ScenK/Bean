import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #982: a watch commitment drafted in the desktop chat → lead-in + card → Save writes an enabled
// sprout with its default end, the owner's ask and the Home sink, through the real IPC guard.
test("sprout draft card: a commitment shows when it stops; Save writes it on with until, ask and Home", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const beanDir = join(home.homeDir, ".bean");
  const draft = {
    name: "album-watch", description: '"tell me when the album is out" — asked Nov 20, 2026', enabled: true,
    cron: "0 9 * * *", webSearch: true,
    steps: [{ kind: "chat", id: "check", instruction: "Is the album out? Search the web.",
      route: { paths: [{ when: "found", goto: "done" }, { when: "nothing", goto: "quiet" }] } }],
    sinks: { home: {} },
  };
  const stub = await startStubOpenAI();
  stub.queue({ toolCall: { name: "propose_routine", args: { json: JSON.stringify(draft) } } });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("watch for the album, tell me when it's out");
    await chat.locator(".bean-send").click();

    const card = chat.locator(".bean-routine-draft");
    await expect(card).toContainText("album-watch");
    await expect(card).toContainText("Watch for");
    await expect(card).toContainText("tell me when the album is out");
    await expect(card).toContainText("Every day at 9:00 AM");
    await expect(card).toContainText("Your chat with Bean");
    await expect(card).toContainText(/Stops.*or sooner if found/);

    await card.getByRole("button", { name: "Save" }).click();
    await expect(chat.locator(".bean-status").last()).toContainText('Saved sprout "album-watch" — it\'s on.');
    await expect(card.getByRole("button", { name: "Saved" })).toBeDisabled();

    const saved = JSON.parse(await readFile(join(beanDir, "routines", "album-watch.json"), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ enabled: true, description: draft.description, sinks: { home: {} } });
    expect(saved.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
