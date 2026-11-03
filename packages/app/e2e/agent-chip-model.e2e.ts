import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #612: the composer's agent chip picks a live agent's project and model; a chosen start reaches
// the real spawn with --model, and a relaunched app's chip opens on the same picks.
test("agent chip: pick project + model, start, relaunch — the chip restores both", async () => {
  const home = await makeBeanHome({ disabledClis: ["opencode", "codex"], autoMemory: false });
  const bin = join(home.homeDir, "fake-bin");
  await mkdir(bin, { recursive: true });
  // A fake claude: records its argv, then exits (the session ends; the picks were already saved).
  await writeFile(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/argv-claude.txt"\nexit 0\n`, "utf8");
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(join(home.homeDir, ".bean", "clis.json"), JSON.stringify([
    { provider: "claude", models: ["sonnet", "opus"] },
  ]), "utf8");
  const stub = await startStubOpenAI();
  const env = {
    HOME: home.homeDir,
    OPENAI_BASE_URL: stub.url,
    PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
  };
  const openChat = async (app: ElectronApplication): Promise<Page> => {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    return chat;
  };
  const pick = async (chat: Page, row: string): Promise<void> => {
    await chat.locator(".bean-agent-chip").click();
    await chat.locator(".bean-chip-menu-row", { hasText: row }).first().click();
  };

  let app = await launchBean(env);
  try {
    let chat = await openChat(app);
    await pick(chat, "Claude Code");
    await pick(chat, "demo");
    await pick(chat, "opus");
    await expect(chat.locator(".bean-agent-chip")).toContainText("Claude Code · demo · opus");
    const composer = chat.locator(".bean-input--composer");
    await composer.fill("fix X");
    await composer.press("Enter");

    await expect.poll(() => readFile(join(home.homeDir, "argv-claude.txt"), "utf8").catch(() => ""), { timeout: 15_000 })
      .not.toBe("");
    const argv = (await readFile(join(home.homeDir, "argv-claude.txt"), "utf8")).trim().split("\n");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    // Saved after the start, model then project — wait for the project key before relaunching.
    // A read can land mid-write (writeFile truncates first), so a parse failure just polls again.
    await expect.poll(async () => readFile(join(home.homeDir, ".bean", "model-memory.json"), "utf8").then((t) => JSON.parse(t) as Record<string, string>).catch(() => ({})), { timeout: 15_000 })
      .toMatchObject({ "live:model:claude": "opus", "desktop:live:project:claude": home.projectPath });

    await app.close();
    app = await launchBean(env);
    chat = await openChat(app);
    await expect(chat.locator(".bean-agent-chip")).toContainText("Bean");
    await pick(chat, "Claude Code");
    await expect(chat.locator(".bean-agent-chip")).toContainText("Claude Code · demo · opus");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
