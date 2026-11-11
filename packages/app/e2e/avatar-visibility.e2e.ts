import { test, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import electronExecutable from "electron";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

const openMenu = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const bean = document.getElementById("bean")!;
    bean.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
  });
  await expect(page.locator(".bean-menu--open")).toBeAttached();
};

test("theme is ready at boot and failed theme IPC retains a visible fallback", { tag: "@ci" }, async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode"] });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    expect(await page.evaluate(() => window.bean.getTheme())).toMatch(/^(hearth|graphite)$/);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("bean:get-theme"));
    await page.reload();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    expect(await page.locator(".bean-orb-body").evaluate((el) => getComputedStyle(el).fill)).not.toBe("none");
    await openMenu(page);
    expect(await page.locator("#bean").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(errors).toEqual([]);
  } finally { await app.close(); await home.cleanup(); }
});

test("all menu tiles fit at each screen corner and display recovery resets an expanded avatar", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode"] });
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    for (const corner of ["tl", "tr", "bl", "br"]) {
      await app.evaluate(({ BrowserWindow, screen }, corner) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!;
        const work = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x: work.x + (corner.endsWith("r") ? work.width - 120 : 0),
          y: work.y + (corner.startsWith("b") ? work.height - 120 : 0), width: 120, height: 120 });
      }, corner);
      await openMenu(page);
      await expect.poll(() => page.locator(".bean-petal--menu").evaluateAll((tiles) => tiles.every((tile) => {
        const r = tile.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }))).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => innerHeight)).toBe(120);
    }
    await openMenu(page);
    await app.evaluate(({ screen }) => {
      const original = screen.getDisplayMatching;
      screen.getDisplayMatching = (rect) => {
        const d = original(rect);
        return { ...d, workArea: { ...d.workArea, height: 120 } };
      };
      try { screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), ["workArea"]); }
      finally { screen.getDisplayMatching = original; }
    });
    await expect(page.locator(".bean-menu--open")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(120);
    await openMenu(page); // renderer and main modes agree after recovery
    await expect(page.locator(".bean-petal--menu")).toHaveCount(6);
  } finally { await app.close(); await home.cleanup(); }
});

test("long drag lists scroll and dropping selects the visible skill after scrolling", async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode"] });
  await mkdir(join(home.homeDir, ".bean", "skills"), { recursive: true });
  for (let i = 0; i < 16; i++) await writeFile(join(home.homeDir, ".bean", "skills", `visibility-${i}.md`),
    `---\nname: visibility-${i}\ndescription: Visibility fixture ${i}\ntarget: chat\n---\nSay hello.\n`);
  const app = await launchBean({ HOME: home.homeDir });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".bean-orb-body")).toBeAttached();
    await page.evaluate(() => document.getElementById("bean")!.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true })));
    await expect(page.locator(".bean-drag-bloom--open")).toBeAttached();
    // Keep the native drag watchdog alive while assertions inspect the list.
    await page.evaluate(() => { (window as any).heartbeat = setInterval(() => {
      document.dispatchEvent(new DragEvent("dragover", { cancelable: true }));
    }, 200); });
    const list = page.locator("#bean-drag-bloom .bean-tile-scroll");
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = page.locator("#bean-drag-bloom .bean-petal").last();
    const skill = await last.locator(".bean-petal-name").textContent();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeAllListeners("bean:plan-from-drop");
      ipcMain.on("bean:plan-from-drop", (_e, name) => { (globalThis as any).pickedSkill = name; });
    });
    await last.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/uri-list", "https://example.com");
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2, dataTransfer }));
    });
    await expect.poll(() => app.evaluate(() => (globalThis as any).pickedSkill)).toBe(skill);
  } finally { await app.close(); await home.cleanup(); }
});

for (const failure of ["early", "config"] as const) {
  test(`fatal ${failure} startup failure reports its error and exits`, async () => {
    const home = await makeBeanHome();
    try {
      if (failure === "config") await writeFile(join(home.homeDir, ".bean", "config.json"), "invalid json");
      const entry = join(home.homeDir, "failure-entry.mjs");
      const mainUrl = new URL("../dist/main.js", import.meta.url).href;
      await writeFile(entry, `
        import { dialog, nativeImage } from "electron";
        dialog.showErrorBox = (title, message) => console.log("STARTUP_ERROR", title, message);
        ${failure === "early" ? 'nativeImage.createMenuSymbol = () => { throw new Error("fixture early failure"); };' : ''}
        await import(${JSON.stringify(mainUrl)});
      `);
      // An invisible surviving process hits this timeout. No real modal UI blocks the test.
      const result = await promisify(execFile)(electronExecutable as unknown as string,
        [entry, `--user-data-dir=${home.homeDir}/userdata`],
        { env: { ...process.env, HOME: home.homeDir }, timeout: 10_000 });
      expect(result.stdout).toContain("STARTUP_ERROR Bean could not start");
      if (failure === "early") expect(result.stdout).toContain("fixture early failure");
    } finally { await home.cleanup(); }
  });
}

test("Bring Bean Back reloads a crashed avatar with its running job's bubble, without stopping the job", { tag: "@ci" }, async () => {
  const home = await makeBeanHome({ disabledClis: ["claude", "codex", "opencode"], autoMemory: false });
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  // Read through main: Playwright's Page for the avatar doesn't survive its renderer dying.
  // A probe that spans the renderer swap throws "Render frame was disposed"; report it as a
  // value so the poll retries instead of failing.
  const inAvatar = (js: string) => app.evaluate(({ BrowserWindow }, js) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!;
    return win.webContents.isCrashed() ? "crashed" : win.webContents.executeJavaScript(js);
  }, js).catch(() => "swapping");
  const avatarLog = () => readFile(join(home.homeDir, ".bean", "logs", "avatar.log"), "utf8").catch(() => "");
  try {
    const avatar = await app.firstWindow();
    await expect(avatar.locator(".bean-orb-body")).toBeAttached();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    stub.queue({ hang: true }); // a turn that keeps running until stopped
    await chat.locator(".bean-input--composer").fill("keep working");
    await chat.locator(".bean-send").click();
    await expect(avatar.locator(".bean-bubble")).toHaveCount(1);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("avatar.html"))!.webContents.forcefullyCrashRenderer();
    });
    await expect.poll(() => inAvatar("1")).toBe("crashed");
    const dock = () => app.evaluate(({ app }) => app.dock?.isVisible() ?? null);
    const dockBefore = await dock();
    await app.evaluate(() => (globalThis as { beanBringBack?: () => void }).beanBringBack!());
    expect(await dock()).toBe(dockBefore); // the Space hop must not flip the activation policy
    // Probe the page only once main has finished the reload; its budget is AVATAR_RELOAD_TIMEOUT_MS (10 s).
    await expect.poll(avatarLog, { timeout: 15_000 }).toMatch(/ bring-back-outcome \{"outcome":"reload ok"/);
    await expect.poll(() => inAvatar(`!!document.querySelector(".bean-orb-body")`)).toBe(true);
    await expect.poll(() => inAvatar(`document.querySelectorAll(".bean-bubble").length`)).toBe(1);
    await expect(chat.locator(".bean-bubble--working")).toHaveCount(1); // the turn kept running
    expect(stub.aborted()).toBe(0);

    const log = await avatarLog();
    expect(log).toMatch(/ render-process-gone \{"reason":"/);
    expect(log).toMatch(/ bring-back \{.*"crashed":true/);
    expect(log).toMatch(/ bring-back-outcome \{"outcome":"reload ok"/);
    expect(log).not.toContain(home.homeDir);
  } finally { await Promise.allSettled([app.close(), stub.close(), home.cleanup()]); }
});
