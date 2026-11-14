import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";
import { appendMemories, dbFile } from "@bean/core";
import { join } from "node:path";

test("component windows: skills, projects, settings open and render their fixture data", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const open = (kind: string) =>
      Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate(
          (k) => (window as unknown as { bean: { openComponent: (kind: string) => void } }).bean.openComponent(k),
          kind,
        ),
      ]).then(([win]) => win);

    const skills = await open("skills");
    await expect(skills.locator(".bean-skills-row-name", { hasText: "draft-reply" })).toBeVisible();

    const projects = await open("projects");
    await expect(projects.locator(".bean-projects-name", { hasText: "demo" })).toBeVisible();

    const settings = await open("settings");
    await expect(settings.locator('input[placeholder="sk-…"]')).toBeVisible();
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #201: a long memory list scrolls inside the Persona panel at the default window size; the
// shell stays put. Checks geometry, not toBeVisible() — that ignores overflow-hidden clipping.
test("persona: a long memory list scrolls within the panel", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const memories = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    text: `seed fact ${i}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...(i >= 30 ? { projectPath: home.projectPath } : {}),
    ...(i === 5 ? { subjectId: "discord:alice" } : {}),
  }));
  await appendMemories(dbFile(join(home.homeDir, ".bean")), memories);
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [persona] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("persona")),
    ]);
    await persona.waitForLoadState("domcontentloaded");
    const panel = persona.locator(".bean-persona");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(60);
    expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await panel.hover();
    await persona.mouse.wheel(0, 10_000);
    await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    const inView = await panel.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const items = el.querySelectorAll(".bean-memory-item");
      const last = items[items.length - 1]!;
      const inside = (n: Element) => {
        const r = n.getBoundingClientRect();
        return r.top >= box.top && r.bottom <= box.bottom;
      };
      return inside(last.querySelector(".bean-memory-input")!) && inside(last.querySelector(".bean-memory-del")!);
    });
    expect(inView).toBe(true);
    expect(await persona.locator(".bean-dashboard").evaluate((el) => el.scrollTop)).toBe(0);

    // #464: each row shows its saved date, private rows a lock; search filters rows across groups.
    await expect(persona.locator(".bean-memory-date").first()).toContainText("2026");
    await expect(persona.locator(".bean-memory-private")).toHaveCount(1);
    await persona.locator(".bean-memory-search").fill("FACT 5");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(11); // 5 and 50–59
    // A short list leaves spare height in the column-flex panel; the search box must not grow into it.
    await persona.locator(".bean-memory-search").fill("no such memory");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(0);
    expect(await persona.locator(".bean-memory-search").evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(48);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #492/#505: chat opens at 820×760 (clamped to the work area — CI's display is shorter), can't shrink
// below 440×520, and a resize survives close + reopen.
test("chat window: default size, minimum size, remembered size", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const openChat = () =>
      Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
      ]).then(([win]) => win);
    const chatSize = () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))?.getSize());
    const resizeChat = (w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/chat.html"))!.setSize(w!, h!), [w, h]);

    const chat = await openChat();
    // Wait for the mount: the close hand-off listener only exists once React has rendered.
    await expect(chat.locator(".bean-input--composer")).toBeVisible();
    const work = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(await chatSize()).toEqual([Math.min(820, work.width), Math.min(760, work.height)]);

    await resizeChat(100, 100);
    expect(await chatSize()).toEqual([440, 520]);

    // Fits any display tall enough for the minimum, so the OS doesn't clamp it.
    await resizeChat(500, 560);
    await Promise.all([
      chat.waitForEvent("close"),
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.close()),
    ]);

    const reopened = await openChat();
    await expect(reopened.locator(".bean-input--composer")).toBeVisible();
    expect(await chatSize()).toEqual([500, 560]);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

// #860: the Dashboard's Remembered day lists today's rows the owner may see, read live from the
// memory list; Forget is the shared per-row delete, so Persona loses the row too.
test("dashboard: Remembered shows today's rows and Forget removes them from Persona too", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const now = new Date().toISOString();
  await appendMemories(dbFile(join(home.homeDir, ".bean")), [
    { id: "today", text: "Only in staging", context: "deploy cluster", createdAt: now },
    { id: "member", text: "Alice's private fact", subjectId: "discord:alice", createdAt: now },
    { id: "old", text: "An old fact", createdAt: "2026-08-01T00:00:00.000Z" },
  ]);
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const open = (kind: string) =>
      Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate((k) => (window as unknown as { bean: { openComponent: (kind: string) => void } }).bean.openComponent(k), kind),
      ]).then(([win]) => win);

    const dash = await open("dashboard");
    const rememberedRow = dash.locator(".bean-dash-row", { has: dash.locator(".bean-dash-dot--remembered") });
    await expect(rememberedRow).toHaveCount(1); // today only: no entry for a day without rows
    await rememberedRow.click();
    await expect(dash.locator(".bean-dash-title")).toContainText("Remembered");
    const rows = dash.locator(".bean-dash-remembered-row");
    await expect(rows).toHaveCount(1); // another member's private row is not shown
    await expect(rows.first()).toContainText("Only in staging");
    await expect(rows.first()).toContainText("re: deploy cluster");
    await expect(dash.locator(".bean-dash-remembered-group .bean-field-label")).toHaveText("Chats with Bean");

    await rows.first().getByRole("button", { name: "Forget" }).click();
    await expect(rememberedRow).toHaveCount(0);
    await expect(dash.locator(".bean-dash-title")).not.toContainText("Remembered");

    const persona = await open("persona");
    await persona.waitForLoadState("domcontentloaded");
    await expect(persona.locator(".bean-memory-input")).toHaveCount(2);
    await expect(persona.locator('[data-memory-id="today"]')).toHaveCount(0);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
