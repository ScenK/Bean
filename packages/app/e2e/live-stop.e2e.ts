import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #724: Stop and Esc Esc end the running live turn and keep the session. A fake claude logs every
// stdin line with its pid, starts a turn per user line that never finishes on its own, and answers
// the stream-json interrupt with claude's `error_during_execution` result.
const FAKE_CLAUDE = `#!/bin/sh
log="$HOME/claude-stdin.txt"
id=11111111-1111-4111-8111-111111111111
n=0
while IFS= read -r line; do
  printf '%s %s\\n' "$$" "$line" >> "$log"
  case "$line" in
    *'"subtype":"interrupt"'*)
      echo '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":5,"session_id":"'$id'"}' ;;
    *'"type":"user"'*)
      n=$((n+1))
      [ $n -eq 1 ] && echo '{"type":"system","subtype":"init","session_id":"'$id'"}'
      echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on turn '$n'"}]}}' ;;
  esac
done
`;

test("live agent: Stop and Esc Esc interrupt the turn, the session stays; a single Esc does nothing", async () => {
  const home = await makeBeanHome({ disabledClis: ["opencode", "codex"], autoMemory: false });
  const bin = join(home.homeDir, "fake-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), FAKE_CLAUDE, "utf8");
  await chmod(join(bin, "claude"), 0o755);
  const stub = await startStubOpenAI();
  const app = await launchBean({
    HOME: home.homeDir,
    OPENAI_BASE_URL: stub.url,
    PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
  });
  const lines = async (): Promise<string[]> =>
    (await readFile(join(home.homeDir, "claude-stdin.txt"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const interrupts = async (): Promise<number> => (await lines()).filter((l) => l.includes('"subtype":"interrupt"')).length;
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
    const banner = chat.locator(".bean-agent-banner");
    const stop = banner.getByRole("button", { name: "Stop" });
    const footers = chat.getByText("— turn interrupted");

    // Turn 1 — the banner's Stop.
    await composer.fill("first");
    await composer.press("Enter");
    await expect(chat.getByText("Working on turn 1")).toBeVisible({ timeout: 15_000 });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(footers).toHaveCount(1);
    await expect(stop).toHaveCount(0);
    expect(await interrupts()).toBe(1);
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "End" })).toBeVisible();

    // Turn 2 — Esc Esc in the composer, on the same process.
    await composer.fill("second");
    await composer.press("Enter");
    await expect(chat.getByText("Working on turn 2")).toBeVisible();
    await expect(stop).toBeVisible();
    await composer.press("Escape");
    await expect(banner.getByText("Esc again to stop")).toBeVisible();
    await composer.press("Escape");
    await expect(footers).toHaveCount(2);
    expect(await interrupts()).toBe(2);

    // Turn 3 — a single Esc with the history overlay open only closes the overlay.
    await composer.fill("third");
    await composer.press("Enter");
    await expect(chat.getByText("Working on turn 3")).toBeVisible();
    await expect(stop).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.setSize(500, 600);
    });
    await chat.getByRole("button", { name: "Show chat history" }).click();
    await expect(chat.locator(".bean-chat-sidebar--overlay")).toBeVisible();
    await composer.focus();
    await composer.press("Escape");
    await expect(chat.locator(".bean-chat-sidebar--overlay")).toHaveCount(0);
    await chat.waitForTimeout(1_200); // past the Esc Esc window
    await expect(banner.getByText("Esc again to stop")).toHaveCount(0);
    expect(await interrupts()).toBe(2);
    await expect(footers).toHaveCount(2);

    // Every line reached one claude process.
    expect(new Set((await lines()).map((l) => l.split(" ")[0])).size).toBe(1);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
