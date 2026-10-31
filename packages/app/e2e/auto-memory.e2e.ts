import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { appendMemories, dbFile } from "@bean/core";
import { join } from "node:path";

// #177 + per-turn capture: a typed turn's facts are saved right after the reply, with a
// "Remembered" row in the chat whose Undo forgets them; closing stays instant (no card).
test("auto memory: a typed turn is captured with an Undo row, close is instant", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Noted!" }); // the chat turn
  stub.queue({ toolCall: { name: "remember", args: { text: "Prefers pnpm over npm", quote: "I prefer pnpm" } } }); // per-turn capture
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("I prefer pnpm over npm");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Noted!");

    const row = chat.locator(".bean-status", { hasText: "Remembered" });
    await expect(row).toContainText("Prefers pnpm over npm");
    await row.getByRole("button", { name: "Undo" }).click();
    await expect(chat.locator(".bean-status", { hasText: "Forgot" })).toContainText("Prefers pnpm over npm");

    const started = Date.now();
    const closed = chat.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("chat"))!.close();
    });
    await closed;
    // ponytail: 200ms is the product bar; e2e allows CI jitter on top.
    expect(Date.now() - started).toBeLessThan(1500);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #177 PR 2: with ≥5 memories saved since the last dream (none yet), the close that saves the
// next batch also dreams; the digest shows as a bubble and Persona's "Last dream" row undoes it.
test("dream: a due close tidies memory in the background and Undo last dream restores it", async () => {
  const home = await makeBeanHome();
  const file = dbFile(join(home.homeDir, ".bean"));
  await appendMemories(file, ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `seed fact ${id}`, createdAt: "2026-08-01T00:00:00.000Z" })));
  const stub = await startStubOpenAI();
  stub.queue({ content: "Noted!" });
  stub.queue({ toolCall: { name: "remember", args: { text: "Prefers pnpm over npm", quote: "I prefer pnpm" } } });
  stub.queue({ toolCall: { name: "drop_memory", args: { id: "a" } } }); // the dream pass
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("I prefer pnpm over npm");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Noted!");
    const closed = chat.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("chat"))!.close();
    });
    await closed;

    const bubble = avatar.locator('.bean-bubble[data-id="memory:dream"]');
    await expect(bubble).toContainText("Tidied memory: removed 1");
    const [persona] = await Promise.all([app.waitForEvent("window"), bubble.click()]);
    await persona.waitForLoadState("domcontentloaded");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(5); // a dropped, pnpm added
    await persona.getByRole("button", { name: /Details/ }).click();
    await expect(persona.locator(".bean-memory-dream-row")).toContainText("seed fact a → removed");
    await persona.locator(".bean-memory-just", { hasText: "Last dream" }).getByRole("button", { name: "Undo" }).click();
    await expect(persona.getByText("Last dream")).toHaveCount(0);
    await expect(persona.locator(".bean-memory-input")).toHaveCount(6);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #571: a forget turn (model → forget_memory → intent classifier yes → reply) shows a Forgot
// receipt per deleted fact; its Undo re-appends the row, so Persona lists the fact again.
test("forget: a Forgot receipt row whose Undo brings the memory back in Persona", async () => {
  const home = await makeBeanHome();
  await appendMemories(dbFile(join(home.homeDir, ".bean")), [
    { id: "f1", text: "Lives in Seattle", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "k1", text: "Uses zed", createdAt: "2026-08-01T00:00:00.000Z" },
  ]);
  const stub = await startStubOpenAI();
  stub.queue({ toolCall: { name: "forget_memory", args: { ids: ["f1"] } } }); // the chat turn
  stub.queue({ content: '{"remember": false, "forget": true}' }); // the intent check
  stub.queue({ content: "Forgotten." }); // the reply after the tool result
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const open = async (kind: string) => {
      const [win] = await Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate((k) => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent(k), kind),
      ]);
      await win.waitForLoadState("domcontentloaded");
      return win;
    };
    const chat = await open("chat");
    await chat.locator(".bean-input--composer").fill("forget where I live");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Forgotten.");

    const row = chat.locator(".bean-status--forgot");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Forgot — Lives in Seattle");
    await row.getByRole("button", { name: "Undo" }).click();
    await expect(row).toHaveText("🧠 Restored — Lives in Seattle");

    const persona = await open("persona");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(2);
    const texts = await persona.locator(".bean-memory-input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort());
    expect(texts).toEqual(["Lives in Seattle", "Uses zed"]);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
