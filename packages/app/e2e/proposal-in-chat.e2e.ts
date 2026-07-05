import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("proposal (in-chat target): confirming sends the composed prompt in chat", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  // First request: the model proposes running the "draft-reply" skill (target: chat).
  // Depends on .bean/skills/draft-reply.md's current name + `target: chat` frontmatter.
  stub.queue({
    toolCall: { name: "propose_run", args: { skill: "draft-reply", project: home.projectPath, instruction: "reply to Jane" } },
  });
  // Second request: the follow-up send triggered by confirming an in-chat proposal.
  stub.queue({ content: "Here's a draft reply to Jane." });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("draft a reply to Jane");
    await chat.locator(".bean-send").click();

    const card = chat.locator(".bean-card");
    await expect(card).toContainText("draft-reply");
    await card.locator(".bean-btn").first().click(); // "Confirm & run"

    await expect(chat.locator(".bean-status")).toContainText("Running here");
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("Here's a draft reply to Jane.");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
