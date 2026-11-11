import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { dbFile, saveDesktopChat } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #779: Cmd+click on a URL or path in a live reply, its steps <pre> and a delegate card sends exactly
// one IPC call; a plain click sends none; a local-href anchor never navigates the chat window.
const REPLY = "Fetched `https://example.com/code` and wrote /tmp/bean-e2e/out.md, see [the notes](/abs/notes.md).";
const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Fetch https://example.com/step" }, { type: "text", text: REPLY }] },
});
const FAKE_CLAUDE = `#!/bin/sh
id=22222222-2222-4222-8222-222222222222
while IFS= read -r line; do
  case "$line" in
    *'"type":"user"'*)
      echo '{"type":"system","subtype":"init","session_id":"'$id'"}'
      echo '${ASSISTANT}' ;;
  esac
done
`;

async function openChat(app: ElectronApplication): Promise<Page> {
  const avatar = await app.firstWindow();
  const [chat] = await Promise.all([
    app.waitForEvent("window"),
    avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
  ]) as [Page, unknown];
  await chat.waitForLoadState("domcontentloaded");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))?.isVisible())).toBe(true);
  return chat;
}

// Main's handlers swapped for recorders: what the renderer asked to open, nothing actually opened.
const record = (app: ElectronApplication) => app.evaluate(({ ipcMain }) => {
  const g = globalThis as unknown as { opened: string[] };
  g.opened = [];
  for (const ch of ["bean:terminal-open-link", "bean:chat-open-path"]) {
    ipcMain.removeAllListeners(ch);
    ipcMain.on(ch, (_e, raw: unknown) => { g.opened.push(`${ch.endsWith("link") ? "url" : "path"} ${String(raw)}`); });
  }
});
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);

// The centre of `token`'s first occurrence in a text node under `scope`.
const pointOf = (page: Page, scope: string, token: string) => page.evaluate(([scope, token]) => {
  const root = [...document.querySelectorAll(scope)].find((el) => !el.closest("[hidden]"))!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.textContent!.indexOf(token);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + token.length);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  throw new Error(`token not found: ${token}`);
}, [scope, token] as const);

async function click(page: Page, scope: string, token: string, meta: boolean): Promise<void> {
  const { x, y } = await pointOf(page, scope, token);
  if (meta) await page.keyboard.down("Meta");
  await page.mouse.click(x, y);
  if (meta) await page.keyboard.up("Meta");
}

test("chat links: Cmd+click in a live reply and its steps opens once; plain clicks and local anchors do nothing", async () => {
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
  try {
    const chat = await openChat(app);
    await expect(chat.getByText("⌘-click a link or path to open it")).toBeVisible();
    await chat.locator(".bean-agent-chip").click();
    await chat.locator(".bean-chip-menu-row", { hasText: "Claude Code" }).first().click();
    await chat.locator(".bean-input--composer").fill("go");
    await chat.locator(".bean-input--composer").press("Enter");
    const reply = ".bean-bubble--bean .bean-md";
    await expect(chat.locator(reply)).toContainText("wrote /tmp/bean-e2e/out.md", { timeout: 15_000 });
    await record(app);
    const url = chat.url();

    await click(chat, reply, "out.md", false);
    await click(chat, reply, "example.com/code", false);
    await click(chat, reply, "the notes", false); // local href: no navigation
    expect(await opened(app)).toEqual([]);
    expect(chat.url()).toBe(url);

    // Cmd-hover underlines only the hovered token, and only while Cmd is held.
    const underlined = () => chat.evaluate(() => {
      const h = CSS.highlights.get("bean-link");
      return h ? [...h].map((r) => (r as Range).toString()) : [];
    });
    const p = await pointOf(chat, reply, "out.md");
    await chat.mouse.move(p.x, p.y);
    expect(await underlined()).toEqual([]);
    await chat.keyboard.down("Meta");
    await chat.mouse.move(p.x + 1, p.y);
    await expect.poll(underlined).toEqual(["/tmp/bean-e2e/out.md"]);
    await chat.keyboard.up("Meta");
    await expect.poll(underlined).toEqual([]);

    await click(chat, reply, "example.com/code", true);
    await click(chat, reply, "out.md", true);
    await click(chat, reply, "the notes", true);
    await chat.locator(".bean-agent-tail summary").click();
    await click(chat, ".bean-agent-tail pre", "example.com/step", true);
    await click(chat, ".bean-bubble--user", "go", true); // the user's own message is never a link
    await expect.poll(() => opened(app)).toEqual([
      "url https://example.com/code",
      "path /tmp/bean-e2e/out.md",
      "path /abs/notes.md",
      "url https://example.com/step",
    ]);
    expect(chat.url()).toBe(url);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

test("chat links: Cmd+click on a URL in a delegate card's result opens it once", async () => {
  const home = await makeBeanHome();
  const id = "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d";
  const delegate = {
    kind: "delegate", id: "d1", state: "done", tail: [], result: "Report at https://example.com/report ready",
    proposal: { cli: "claude", projectPath: "", composedPrompt: "p", instruction: "write the report" },
  };
  saveDesktopChat(dbFile(join(home.homeDir, ".bean")), {
    id, title: "report", itemsJson: JSON.stringify([{ kind: "user", id: "a", text: "report" }, delegate]),
  });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const chat = await openChat(app);
    await chat.locator(`[data-row="${id}"]`).click();
    await chat.getByRole("button", { name: "Show result" }).click();
    await record(app);
    await click(chat, ".bean-delegate-output", "example.com/report", false);
    await click(chat, ".bean-delegate-output", "example.com/report", true);
    await expect.poll(() => opened(app)).toEqual(["url https://example.com/report"]);
  } finally {
    await Promise.allSettled([app.close(), home.cleanup()]);
  }
});
