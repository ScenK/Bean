import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("chat: sending a message renders the stubbed reply", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello from stub!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("hi bean");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello from stub!");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

test("chat: the / menu lists every skill, skills first, in a bounded box that scrolls", async () => {
  const home = await makeBeanHome();
  for (let i = 1; i <= 20; i++) {
    const n = String(i).padStart(2, "0");
    await writeFile(join(home.homeDir, ".bean", "skills", `extra-${n}.md`), `---\ntarget: chat\ndescription: Extra ${n}\n---\n\n# Extra ${n}\n`, "utf8");
  }
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    const composer = chat.locator(".bean-input--composer");
    await composer.fill("/");
    const menu = chat.locator(".bean-slash-menu");
    await expect(menu.locator(".bean-chip-menu-hint").first()).toHaveText("Skills");
    await expect(menu.locator(".bean-chip-menu-row", { hasText: "/extra-20" })).toHaveCount(1);
    await expect(menu).not.toContainText("more");
    const box = await menu.evaluate((el) => ({ height: el.getBoundingClientRect().height, scrolls: el.scrollHeight > el.clientHeight }));
    expect(box.height).toBeLessThanOrEqual(320 + 2 * 6 + 2 * 1); // .bean-slash-menu max-height + padding + border
    expect(box.scrolls).toBe(true);
    // ↓ reaches the last skill (the row before the Sprouts heading) and keeps it in view.
    const lastSkill = await menu.evaluate((el) => {
      const rows = [...el.querySelectorAll(".bean-chip-menu-row")];
      const sprouts = [...el.querySelectorAll(".bean-chip-menu-hint")].find((h) => h.textContent === "Sprouts");
      const before = rows.filter((r) => sprouts && r.compareDocumentPosition(sprouts) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { index: before.length - 1, text: before.at(-1)?.textContent ?? "" };
    });
    for (let i = 0; i < lastSkill.index; i++) await composer.press("ArrowDown");
    const active = menu.locator(".bean-chip-menu-row--on");
    await expect(active).toHaveText(lastSkill.text);
    await expect.poll(() => active.evaluate((row) => {
      const r = row.getBoundingClientRect(), m = row.parentElement!.getBoundingClientRect();
      return r.top >= m.top - 1 && r.bottom <= m.bottom + 1;
    })).toBe(true);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
