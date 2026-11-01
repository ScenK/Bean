import { test, expect } from "@playwright/test";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// The delegate card's CLI pick reaches the real spawn: a fake codex records its argv and cwd.
// Run against a packaged build with BEAN_E2E_EXECUTABLE (launch-app.ts).
test("delegate card: picking codex over a claude-only remembered model spawns codex in the picked project", async () => {
  const home = await makeBeanHome({ disabledClis: ["opencode"], autoMemory: false });
  const bin = join(home.homeDir, "fake-bin");
  await mkdir(bin, { recursive: true });
  for (const cli of ["claude", "codex"]) {
    await writeFile(join(bin, cli), `#!/bin/sh\n{ pwd -P; printf '%s\\n' "$@"; } > "$HOME/argv-${cli}.txt"\nexit 0\n`, "utf8");
    await chmod(join(bin, cli), 0o755);
  }
  await writeFile(join(home.homeDir, ".bean", "clis.json"), JSON.stringify([
    { provider: "claude", models: ["sonnet"] },
    { provider: "codex", models: ["gpt-codex"] },
  ]), "utf8");
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
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.evaluate(() => (window as unknown as { bean: { setModelMemory: (s: string, m: string) => Promise<void> } })
      .bean.setModelMemory("review-pr", "sonnet"));
    const composer = chat.locator(".bean-input--composer");
    await composer.fill("/review-pr fix X");
    await composer.press("Enter");

    const card = chat.locator(".bean-card").filter({ hasText: "delegate · background agent" });
    const trigger = (text: string) => card.locator(".bean-chip-menu-trigger", { hasText: text });
    await expect(trigger("claude")).toBeVisible(); // the remembered claude-only model picks claude
    await expect(trigger("sonnet")).toBeVisible();
    await trigger("claude").click();
    await chat.locator(".bean-chip-menu-row", { hasText: "codex" }).click();
    await expect(trigger("gpt-codex")).toBeVisible(); // the stale model is swapped for codex's
    await trigger("project ·").click();
    await chat.locator(".bean-chip-menu-row", { hasText: "demo" }).click();
    await card.getByRole("button", { name: "Delegate" }).click();

    await expect.poll(() => readFile(join(home.homeDir, "argv-codex.txt"), "utf8").catch(() => ""), { timeout: 15_000 })
      .not.toBe("");
    const [cwd, ...argv] = (await readFile(join(home.homeDir, "argv-codex.txt"), "utf8")).trim().split("\n");
    expect(cwd).toBe(await realpath(home.projectPath)); // `pwd -P`: the real cwd, not the PWD env
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("gpt-codex");
    expect(argv).not.toContain("sonnet");
    await expect(readFile(join(home.homeDir, "argv-claude.txt"), "utf8")).rejects.toThrow();
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

