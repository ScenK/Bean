import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

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
