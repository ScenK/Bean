import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #628: an image dropped into an agent-mode composer becomes an `[Image #N]` label; the agent's
// input carries the staged file's path, the transcript only the label.
test("agent mode: a dropped PNG becomes [Image #1] and the agent gets its path", async () => {
  const home = await makeBeanHome({ disabledClis: ["opencode", "codex"], autoMemory: false });
  const bin = join(home.homeDir, "fake-bin");
  await mkdir(bin, { recursive: true });
  // A fake claude: copies its stream-json stdin to a file and never answers.
  await writeFile(join(bin, "claude"), `#!/bin/sh\ncat > "$HOME/stdin-claude.txt"\n`, "utf8");
  await chmod(join(bin, "claude"), 0o755);
  const stub = await startStubOpenAI();
  const app = await launchBean({
    HOME: home.homeDir,
    OPENAI_BASE_URL: stub.url,
    PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
  });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]) as [Page, unknown];
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-agent-chip").click();
    await chat.locator(".bean-chip-menu-row", { hasText: "Claude Code" }).first().click();

    const composer = chat.locator(".bean-input--composer");
    // A browser-style drop (no file path): the image is staged through main.
    await composer.evaluate((el) => {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(composer).toHaveValue("[Image #1] ");

    await composer.press("End");
    await composer.pressSequentially("what is this?");
    await composer.press("Enter");
    await expect(chat.locator(".bean-bubble--user").last()).toHaveText(/\[Image #1\] what is this\?( \(not read yet\))?$/);
    await expect.poll(() => readFile(join(home.homeDir, "stdin-claude.txt"), "utf8").catch(() => ""), { timeout: 15_000 })
      .toMatch(/\[Image #1\]: \/[^"\\]+\.png/);
    await expect(chat.locator(".bean-chat-scroll")).not.toContainText(".png");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
