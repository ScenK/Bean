import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBean } from "./fixtures/launch-app.js";

type Bean = { bean: { openComponent: (k: string) => Promise<void>; listNotes: () => Promise<unknown>; handshake: () => Promise<unknown> } };

// #810: with the local core switched off, the shell boots with no ~/.bean, the avatar opens Add a core,
// every window that needs a core opens Add a core instead, and a core call rejects with NO_CORE.
// win-installer.yml also runs this spec against the installed Windows Bean.exe (#814).
test("no core attached: boots without a data directory and shows Add a core", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "bean-e2e-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  await writeFile(join(userDataDir, "cores.json"), JSON.stringify({ selected: null }));
  // USERPROFILE: os.homedir() reads it, not HOME, on Windows.
  const app = await launchBean({ HOME: homeDir, USERPROFILE: homeDir }, userDataDir);
  const errors: string[] = [];
  const watch = (p: Page): void => { p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`)); };
  app.on("window", watch);
  try {
    const avatar = await app.firstWindow();
    watch(avatar);
    await expect(avatar.locator("#bean")).toBeVisible();

    // A click on the bean opens Add a core, not the quick actions. The avatar learns there's no core from
    // its boot handshake; a second one, answered in order, means that answer has landed.
    await avatar.evaluate(() => (window as unknown as Bean).bean.handshake().catch(() => {}));
    const [cores] = await Promise.all([app.waitForEvent("window"), avatar.evaluate(() => {
      document.getElementById("bean")!.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup"));
    })]);
    await expect(cores.locator(".bean-cores")).toContainText("Add a core");
    // Local core is macOS-only (#813): no "This Mac" row elsewhere.
    await expect(cores.getByRole("button", { name: "Use this Mac" })).toHaveCount(process.platform === "darwin" ? 1 : 0);

    // Add a remote core (#811): a malformed host is refused; a good one is listed, not yet in use.
    await cores.getByLabel("Host").fill("-oProxyCommand=x");
    await cores.getByRole("button", { name: "Add core" }).click();
    await expect(cores.locator(".bean-about-update-error")).toContainText("user@host");
    await cores.getByLabel("Host").fill("me@box");
    await cores.getByLabel("Docker container (optional)").fill("bean");
    await cores.getByRole("button", { name: "Add core" }).click();
    await expect(cores.locator(".bean-cores-row", { hasText: "me@box · bean" }).getByRole("button", { name: "Use" })).toBeVisible();

    // Every core window lands on that same panel; only About opens on its own.
    for (const kind of ["chat", "skills", "persona", "projects", "notes", "plan", "settings", "routines", "dashboard"]) {
      await avatar.evaluate((k) => (window as unknown as Bean).bean.openComponent(k), kind);
    }
    expect(app.windows()).toHaveLength(2);
    const [about] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as Bean).bean.openComponent("about")),
    ]);
    await expect(about.locator(".bean-about-name")).toHaveText("Bean");

    const rejected = await avatar.evaluate(() => (window as unknown as Bean).bean.listNotes().then(() => "", (e: Error) => e.message));
    expect(rejected).toContain("No core attached");

    expect(errors).toEqual([]);
    expect(existsSync(join(homeDir, ".bean"))).toBe(false);
  } finally {
    await app.close().catch(() => {});
    await Promise.allSettled([rm(homeDir, { recursive: true, force: true }), rm(userDataDir, { recursive: true, force: true })]);
  }
});
