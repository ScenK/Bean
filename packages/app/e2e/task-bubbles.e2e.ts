import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";

// The status bubbles (design 2a): a pushed job list renders above the bean, the avatar window
// grows upward to hold the stack without moving the bean, and an empty list shrinks it back.
test("status bubbles grow the avatar around a fixed bean and collapse when jobs clear", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode", "agy"] });
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
    // The stack holds new/removed bubbles while hovered, and a click leaves the pointer on it, so
    // each push steps the pointer off first (as a user moving on would).
    const push = async (jobs: unknown[]) => {
      await page.locator(".bean-bubble-stack").dispatchEvent("pointerleave");
      await app.evaluate(({ BrowserWindow }, jobs) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!
          .webContents.send("bean:task-status", jobs);
      }, jobs);
    };

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

    // The open job never folds into the pill: an older one folds in its place (#1093).
    const r6 = { id: "r6", kind: "delegate", name: "job 6", line: "Running…", detail: "", startedAt: now, state: "running" };
    await page.locator('.bean-bubble[data-id="r3"]').click();
    await expect(page.locator(".bean-bubble-line")).toHaveCount(1);
    await push([...many, r6]);
    await expect(page.locator(".bean-bubble")).toHaveCount(4);
    await expect(page.locator('.bean-bubble[data-id="r3"]')).toHaveAttribute("aria-expanded", "true");
    // An open job that leaves doesn't leave the visible ones muted.
    await push([...many.filter((j) => j.id !== "r3"), r6]);
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

// #379: a finished routine bubble is one click to that run in the Dashboard — it dismisses itself,
// opens the Dashboard on the run's (folded, older) day, and an already-open Dashboard follows the
// next click instead of keeping its old selection.
test("a finished routine bubble opens its run in the Dashboard", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode", "agy"] });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    // The stack holds new/removed bubbles while hovered, and a click leaves the pointer on it, so
    // each push steps the pointer off first (as a user moving on would).
    const push = async (jobs: unknown[]) => {
      await page.locator(".bean-bubble-stack").dispatchEvent("pointerleave");
      await app.evaluate(({ BrowserWindow }, jobs) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!
          .webContents.send("bean:task-status", jobs);
      }, jobs);
    };
    await app.evaluate(({ ipcMain }) => {
      ipcMain.on("bean:dismiss-task", (_e, id) => { (globalThis as { dismissed?: string }).dismissed = id; });
    });
    const finished = (name: string, runStartedAt?: string) => ({
      id: `routine:${name}`, kind: "routine", name, line: "Done · 2 steps", detail: "", steps: ["a", "b"],
      startedAt: Date.now(), state: "done", ...(runStartedAt ? { runStartedAt } : {}),
    });

    await push([finished("nightly", "2026-01-01T14:00:00.000Z")]);
    const bubble = page.locator('.bean-bubble[data-id="routine:nightly"]');
    await expect(bubble).toHaveAttribute("title", "Open in Dashboard");
    await expect(bubble).not.toHaveAttribute("aria-expanded", /.*/);
    const [dash] = await Promise.all([app.waitForEvent("window"), bubble.click()]);
    await dash.waitForLoadState("domcontentloaded");
    await expect.poll(() => app.evaluate(() => (globalThis as { dismissed?: string }).dismissed)).toBe("routine:nightly");
    await expect(dash.locator(".bean-dash-title")).toContainText("nightly"); // not the newest bucket (weekly)
    await expect(dash.locator(".bean-skills-row--selected")).toContainText("nightly");

    // Dashboard already open: the push moves it; an unrecorded run lands on the latest one + a notice.
    await push([finished("weekly")]);
    await page.locator('.bean-bubble[data-id="routine:weekly"]').click();
    await expect(dash.locator(".bean-dash-title")).toContainText("weekly");
    await expect(dash.getByRole("status")).toHaveText("That run wasn't recorded — showing the latest recorded one.");
  } finally { await app.close(); await home.cleanup(); }
});

// #965: Stop's label follows the live run count, so its pill keeps one width — a second run under a
// held pointer mustn't grow it leftward over the bubble.
test("an expanded sprout's Stop keeps its width as the run count changes", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode", "agy"] });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    const push = (jobs: unknown[]) => app.evaluate(({ BrowserWindow }, jobs) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!
        .webContents.send("bean:task-status", jobs);
    }, jobs);
    const now = Date.now();
    const run = (id: string, line = "Run test suites") => ({ id, kind: "routine", routine: "nightly", name: "nightly", line,
      detail: "", steps: ["Pull repos", "Run test suites"], step: 1, startedAt: now, state: "running" });
    await push([run("routine:nightly:1")]);
    await page.locator('.bean-bubble[data-id="routine:nightly:1"]').click();
    // Hold the stack as a pointer moving over it would (the window regrows under a real one, so it's flaky).
    await page.locator(".bean-bubble-stack").dispatchEvent("pointermove");
    const stop = page.locator(".bean-bubble-stop");
    const bubble = page.locator('.bean-bubble[data-id="routine:nightly:1"]');
    await expect(stop).toHaveText("Stop");
    // The stack re-renders its markup, so read each box in one evaluate rather than a stale handle.
    const box = (l: typeof stop) => l.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, width: r.width }; });
    const { width } = await box(stop);
    const inside = async () => {
      const s = await box(stop), b = await box(bubble);
      expect(s.x).toBeGreaterThan(b.x);
      expect(s.x + s.width).toBeLessThan(b.x + b.width);
    };
    await inside();
    for (const [n, label] of [[2, "Stop all 2 runs"], [12, "Stop all 12 runs"]] as const) {
      await push(Array.from({ length: n }, (_, i) => run(`routine:nightly:${i + 1}`)));
      await expect(stop).toHaveText(label);
      expect((await box(stop)).width).toBeCloseTo(width, 0);
    }
    await push([run("routine:nightly:1", "Stopping…")]);
    await expect(stop).toHaveText("Stopping…");
    expect((await box(stop)).width).toBeCloseTo(width, 0);
    await inside();
  } finally { await app.close(); await home.cleanup(); }
});
