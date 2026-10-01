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
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
