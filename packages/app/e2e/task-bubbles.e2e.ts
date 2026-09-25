import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";

// The status bubbles (design 2a): a pushed job list renders above the bean, the avatar window
// grows upward to hold the stack without moving the bean, and an empty list shrinks it back.
test("status bubbles grow the avatar around a fixed bean and collapse when jobs clear", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode"] });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    const avatarBounds = () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!.getBounds());
    const beanCenter = async () => {
      const b = await avatarBounds();
      const r = await page.locator("#bean-orb").boundingBox();
      return { x: b.x + r!.x + r!.width / 2, y: b.y + r!.y + r!.height / 2 };
    };
    const push = (jobs: unknown[]) => app.evaluate(({ BrowserWindow }, jobs) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!
        .webContents.send("bean:task-status", jobs);
    }, jobs);

    const idle = await avatarBounds();
    const before = await beanCenter();
    const now = Date.now();
    await push([
      { id: "routine:nightly", kind: "routine", name: "nightly", line: "Run test suites", detail: "",
        steps: ["Pull repos", "Run test suites", "Write brief"], step: 1, startedAt: now - 65_000, state: "running" },
      { id: "d1", kind: "delegate", name: "demo", line: "Reading the <thread>…", detail: "fix the flaky test",
        startedAt: now - 5_000, state: "running" },
    ]);
    await expect(page.locator(".bean-bubble")).toHaveCount(2);
    await expect(page.locator(".bean-bubble--tail")).toHaveAttribute("data-id", "d1"); // newest gets the tail
    await expect(page.locator(`.bean-bubble[data-id="d1"] .bean-bubble-line`)).toContainText("<thread>"); // escaped, not parsed
    await expect.poll(async () => (await avatarBounds()).height).toBeGreaterThan(idle.height);
    const after = await beanCenter();
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);

    if (process.env.BEAN_SHOT) { await page.waitForTimeout(800); await page.screenshot({ path: process.env.BEAN_SHOT.replace(".png", "-closed.png") }); }
    await page.locator('.bean-bubble[data-id="routine:nightly"]').click();
    await expect(page.locator(".bean-bubble-step")).toHaveCount(3);
    if (process.env.BEAN_SHOT) { await page.waitForTimeout(800); await page.screenshot({ path: process.env.BEAN_SHOT }); }

    // A failure stays until clicked away: first click expands it, the second asks main to dismiss.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.on("bean:dismiss-task", (_e, id) => { (globalThis as { dismissed?: string }).dismissed = id; });
    });
    await push([{ id: "bot:discord", kind: "bot", name: "Discord", line: "exited unexpectedly (code 1)",
      detail: "exited unexpectedly (code 1)", startedAt: now, state: "failed", count: 3 }]);
    const failed = page.locator('.bean-bubble[data-id="bot:discord"]');
    await expect(failed.locator(".bean-bubble-meta")).toHaveText("failed ×3");
    await failed.click();
    await expect(page.locator(".bean-bubble-hint")).toBeVisible();
    await failed.click();
    await expect.poll(() => app.evaluate(() => (globalThis as { dismissed?: string }).dismissed)).toBe("bot:discord");

    // A busy chat channel: only the newest 4 show; the pill counts the rest (and their failures)
    // and expands them. The ChatOps turn bubble is the newest, so it keeps the tail.
    const many = [
      { id: "old-fail", kind: "delegate", name: "api", line: "Failed", detail: "", startedAt: now, state: "failed" },
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, kind: "delegate", name: `job ${n}`, line: "Running…", detail: "", startedAt: now, state: "running" })),
      { id: "discord:turn:t1", kind: "chat", name: "Discord · #dev", line: "Replying to alice…", detail: "", startedAt: now, state: "running" },
    ];
    await push(many);
    await expect(page.locator(".bean-bubble")).toHaveCount(4);
    await expect(page.locator(".bean-bubble--tail")).toHaveAttribute("data-id", "discord:turn:t1");
    await expect(page.locator(".bean-bubble-more")).toHaveText("+3 more · 1 failed");
    await page.locator(".bean-bubble-more").click();
    await expect(page.locator(".bean-bubble")).toHaveCount(7);
    await expect(page.locator(".bean-bubble-more")).toHaveAttribute("aria-expanded", "true");
    await page.locator(".bean-bubble-more").click(); // "Show fewer"
    await expect(page.locator(".bean-bubble")).toHaveCount(4);
    await expect(page.locator(".bean-bubble-more")).toBeFocused(); // keyboard focus survives the re-render

    // An open job that folds into the pill doesn't leave the visible ones muted.
    await page.locator('.bean-bubble[data-id="r3"]').click();
    await expect(page.locator(".bean-bubble-line")).toHaveCount(1);
    await push([...many, { id: "r6", kind: "delegate", name: "job 6", line: "Running…", detail: "", startedAt: now, state: "running" }]);
    await expect(page.locator(".bean-bubble-line")).toHaveCount(4);
    // Focus on a job that then folds away lands on the newest bubble instead of vanishing.
    await page.locator('.bean-bubble[data-id="r4"]').focus();
    await push([...many, ...[6, 7].map((n) => ({ id: `r${n}`, kind: "delegate", name: `job ${n}`, line: "Running…", detail: "", startedAt: now, state: "running" }))]);
    await expect(page.locator(".bean-bubble--tail")).toBeFocused();

    await push([]);
    await expect(page.locator(".bean-bubble")).toHaveCount(0);
    await expect(page.locator(".bean-bubble-more")).toHaveCount(0);
    await expect.poll(avatarBounds).toEqual(idle);

    // Parked at the left screen edge, the bubble stays inside the window instead of spilling off.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const work = screen.getPrimaryDisplay().workArea;
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!
        .setBounds({ x: work.x, y: work.y + 400, width: 120, height: 120 });
    });
    await push([{ id: "d2", kind: "delegate", name: "demo", line: "hi", detail: "", startedAt: Date.now(), state: "running" }]);
    await expect(page.locator(".bean-bubble")).toHaveCount(1);
    await expect.poll(async () => (await page.locator(".bean-bubble").boundingBox())!.x).toBeGreaterThanOrEqual(0);
  } finally { await app.close(); await home.cleanup(); }
});
