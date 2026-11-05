import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dbFile, recordDestination, setAlias } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #688: propose_send → a grouped destination picker, pre-selected on a typo's confident match;
// Send queues an outbox file with the resolved id and the exact body, and the receipt says Queued.
test("send card: grouped select, typo pre-selects the row, Send queues an outbox file", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const beanDir = join(home.homeDir, ".bean");
  const db = dbFile(beanDir);
  recordDestination(db, { surface: "discord", conversationId: "c-deploys", kind: "channel", platformName: "deploys", parentName: "Guild" });
  recordDestination(db, { surface: "discord", conversationId: "c-general", kind: "channel", platformName: "general", parentName: "Guild" });
  recordDestination(db, { surface: "teams", conversationId: "t-fam", kind: "group" });
  setAlias(db, { surface: "teams", conversationId: "t-fam" }, "Family", () => []);
  const stub = await startStubOpenAI();
  stub.queue({ toolCall: { name: "propose_send", args: { destination: "deplys", text: "Deploy 1.2 is out." } } });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("tell deplys that deploy 1.2 is out");
    await chat.locator(".bean-send").click();

    const card = chat.locator(".bean-send-card");
    const select = card.getByRole("combobox", { name: "Destination" });
    await expect(select.locator("optgroup")).toHaveCount(2);
    await expect(select.locator('optgroup[label="Discord"] option')).toHaveText(["deploys", "general"]);
    await expect(select.locator('optgroup[label="Teams"] option')).toHaveText(["Family"]);
    await expect(select.locator("option:checked")).toHaveText("deploys");
    await expect(card.locator(".bean-send-target strong")).toHaveText("deploys");
    await expect(card.locator(".bean-send-body")).toHaveText("Deploy 1.2 is out.");
    await expect(card).toContainText("Posts as Bean");
    await expect(card).toContainText("Missing one? Name it in Settings → ChatOps.");

    await card.getByRole("button", { name: "Send" }).click();
    await expect(chat.locator(".bean-status").last()).toContainText("Queued → deploys");

    const outbox = join(beanDir, "outbox");
    const files = (await readdir(outbox)).filter((f) => f.startsWith("discord-"));
    expect(files).toHaveLength(1);
    const msg = JSON.parse(await readFile(join(outbox, files[0]!), "utf8")) as Record<string, unknown>;
    expect(msg).toMatchObject({ transport: "discord", channel: "c-deploys", body: "Deploy 1.2 is out." });
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
