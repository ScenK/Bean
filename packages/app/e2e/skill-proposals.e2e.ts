import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dbFile, saveSkillProposals, skillHash } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

/** A retro proposal in the Skills inbox: the diff shows, Approve writes the skill, Undo puts the
 * exact previous file back. */
test("skills: approve a retro proposal, then undo it", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const beanDir = join(home.homeDir, ".bean");
  const skillFile = join(beanDir, "skills", "review-pr.md");
  const before = await readFile(skillFile, "utf8");
  saveSkillProposals(dbFile(beanDir), [{
    id: "p-e2e", routine: "sdlc-retro", skill: "review-pr", baseHash: skillHash(before),
    body: "---\ndescription: Review a PR\n---\n\n# Review PR\nCheck the tests first.", rationale: "Reviews keep missing tests.",
    evidence: ["run-1"], createdAt: "2026-10-13T00:00:00Z",
  }]);

  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [win] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("skills")),
    ]);
    await win.locator(".bean-skills-proposals-tab").click();
    await expect(win.locator(".bean-diff-add")).toHaveText("+ Check the tests first.");
    await win.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => readFile(skillFile, "utf8")).toContain("Check the tests first.");

    await win.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => readFile(skillFile, "utf8")).toBe(before);
    await expect(win.getByRole("button", { name: "Undo" })).toHaveCount(0);
  } finally {
    await app.close();
    await Promise.allSettled([stub.close(), home.cleanup()]);
  }
});
