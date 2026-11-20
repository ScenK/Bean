import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dbFile, insertHomePost, listPendingHomePosts } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

const runNow = (page: Page, name: string): Promise<void> => page.evaluate((n) => {
  void (window as unknown as { bean: { routinesRunNow: (n: string) => Promise<unknown> } }).bean.routinesRunNow(n);
}, name);

// #961: posts left pending bring the avatar's Home bubble back at boot; its click opens Home, which
// drains them and clears it. A post landing while Home is shown raises the jump-down pill (and the
// bubble); its click appends and drains it. One landing while another chat is shown raises the bubble
// and the Home row's dot until Home is opened.
test("home: boot bubble, the pill on a shown Home, and the dot while another chat is shown", async () => {
  const home = await makeBeanHome({ autoMemory: false, disabledClis: ["claude", "codex", "opencode"] });
  const stub = await startStubOpenAI(); // nothing queued: the post's brief falls back to the step output
  const dir = join(home.homeDir, ".bean");
  await writeFile(join(dir, "routines", "poster.json"), JSON.stringify({
    name: "poster", enabled: false, cron: "0 6 * * *", sinks: { home: {} },
    steps: [{ kind: "command", command: "echo fresh-post" }],
  }), "utf8");
  const file = dbFile(dir);
  insertHomePost(file, { sprout: "digest", body: "left over" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const bubble = avatar.locator('.bean-bubble[data-id="home:posts"]');
    await expect(bubble).toContainText("Bean has 1 post for you");

    const [chat] = await Promise.all([app.waitForEvent("window"), bubble.click()]);
    await expect(chat.locator(".bean-post")).toHaveCount(1);
    await expect(chat.locator(".bean-chat-sidebar-home")).toHaveClass(/bean-chat-sidebar-home--active/);
    await expect(bubble).toHaveCount(0);

    // Home shown: nothing is pushed in; the count raises the pill, whose click loads and drains.
    await runNow(avatar, "poster");
    const pill = chat.locator('.bean-jump-down[aria-label="New posts"]');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(bubble).toContainText("Bean has 1 post for you");
    await expect(chat.locator(".bean-post")).toHaveCount(1);
    await pill.click();
    await expect(chat.locator(".bean-post")).toHaveCount(2);
    await expect(chat.locator(".bean-post").last()).toContainText("fresh-post");
    await expect.poll(() => listPendingHomePosts(file).length).toBe(0);
    await expect(pill).toHaveCount(0);
    await expect(bubble).toHaveCount(0);
    await expect(chat.locator(".bean-chat-sidebar-home .bean-chat-sidebar-dot")).toHaveCount(0);

    // Another chat shown: the bubble and the Home row's dot, until Home is opened.
    await chat.locator(".bean-chat-sidebar-new").click();
    await expect(chat.locator(".bean-chat-sidebar-home")).not.toHaveClass(/--active/);
    await runNow(avatar, "poster");
    await expect(bubble).toContainText("Bean has 1 post for you", { timeout: 15_000 });
    await expect(chat.locator(".bean-chat-sidebar-home .bean-chat-sidebar-dot")).toBeVisible();
    await expect(chat.locator(".bean-post")).toHaveCount(0);
    await chat.locator(".bean-chat-sidebar-home .bean-chat-sidebar-open").click();
    await expect(chat.locator(".bean-post")).toHaveCount(3);
    await expect(bubble).toHaveCount(0);
    await expect(chat.locator(".bean-chat-sidebar-home .bean-chat-sidebar-dot")).toHaveCount(0);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
