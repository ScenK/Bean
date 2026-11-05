import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dbFile, listDestinations, recordDestination } from "@bean/core";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";

// #687: sprout chat sinks pick a named destination instead of a pasted id.

const openRoutines = async (app: ElectronApplication): Promise<Page> => {
  const avatar = await app.firstWindow();
  const [win] = await Promise.all([
    app.waitForEvent("window"),
    avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("routines")),
  ]);
  return win;
};

const sprout = (name: string, chatops: unknown[]): string => JSON.stringify({
  name, enabled: false, cron: "0 6 * * *", steps: [{ kind: "chat", instruction: "check the build" }], sinks: { chatops },
});

test("sink destinations: pick by name, save, reopen shows the name; an unknown name is refused at save", async () => {
  const home = await makeBeanHome();
  const beanDir = join(home.homeDir, ".bean");
  recordDestination(dbFile(beanDir), { surface: "discord", conversationId: "c1", kind: "channel", platformName: "general", parentName: "Guild" });
  const file = join(beanDir, "routines", "pick.json");
  await writeFile(file, sprout("pick", [{ transport: "discord" }]), "utf8");
  await writeFile(join(beanDir, "routines", "ghost.json"), sprout("ghost", [{ transport: "discord" }, { transport: "discord", alias: "Gone" }]), "utf8");
  const chatops = async (): Promise<unknown> =>
    (JSON.parse(await readFile(file, "utf8")) as { sinks: { chatops?: unknown } }).sinks.chatops;

  const app = await launchBean({ HOME: home.homeDir });
  try {
    const win = await openRoutines(app);
    await win.locator(".bean-routines-row", { hasText: "pick" }).click();
    await win.getByRole("button", { name: "+ Add Discord channel" }).click();
    await win.getByLabel("Discord destination").selectOption({ label: "general" });
    // Picking an unnamed conversation names it after its label; the name stays editable.
    const name = win.getByRole("textbox", { name: "Destination name" });
    await expect(name).toHaveValue("general");
    await name.fill("Team chat");
    await name.press("Enter");
    await expect(win.getByLabel("Discord destination")).toHaveValue("alias:Team chat");
    // An uncommitted edit doesn't rename on Save's blur: the sprout and the destination agree.
    await name.fill("Not committed");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect.poll(chatops).toEqual([{ transport: "discord" }, { transport: "discord", alias: "Team chat" }]);
    expect(listDestinations(dbFile(beanDir)).find((d) => d.conversationId === "c1")?.alias).toBe("Team chat");
    // Naming state stays with its sprout: another sprout's row shows no name field.
    await win.locator(".bean-routines-row", { hasText: "ghost" }).click();
    await expect(win.getByRole("textbox", { name: "Destination name" })).toHaveCount(0);

    await win.reload();
    await win.locator(".bean-routines-row", { hasText: "pick" }).click();
    await expect(win.getByLabel("Discord destination")).toHaveValue("alias:Team chat");
    await expect(win.getByLabel("Discord destination").locator("option:checked")).toHaveText("Team chat");

    await win.locator(".bean-routines-row", { hasText: "ghost" }).click();
    await expect(win.getByLabel("Discord destination").locator("option:checked")).toHaveText("Gone (unknown)");
    await win.getByRole("button", { name: "Save sprout" }).click();
    await expect(win.getByText(/"Gone" isn't known/).first()).toBeVisible();
  } finally {
    await app.close();
    await home.cleanup();
  }
});

test("sink destinations: Name it on a raw id names the conversation and rewrites every sprout using it", async () => {
  const home = await makeBeanHome();
  const beanDir = join(home.homeDir, ".bean");
  recordDestination(dbFile(beanDir), { surface: "discord", conversationId: "c1", kind: "channel", platformName: "builds", parentName: "Guild" });
  const dir = join(beanDir, "routines");
  await writeFile(join(dir, "one.json"), sprout("one", [{ transport: "discord", channel: "c1" }]), "utf8");
  await writeFile(join(dir, "two.json"), sprout("two", [{ transport: "discord" }, { transport: "discord", channel: "c1" }]), "utf8");
  await writeFile(join(dir, "other.json"), sprout("other", [{ transport: "discord", channel: "c9" }]), "utf8");
  const chatops = async (n: string): Promise<unknown> =>
    (JSON.parse(await readFile(join(dir, `${n}.json`), "utf8")) as { sinks: { chatops?: unknown } }).sinks.chatops;

  const app = await launchBean({ HOME: home.homeDir });
  try {
    const win = await openRoutines(app);
    await win.locator(".bean-routines-row", { hasText: "one" }).click();
    await expect(win.getByLabel("Discord channel id")).toHaveValue("c1");
    await win.getByRole("button", { name: "Name it" }).click();
    // Lists the sprouts it rewrites before doing it.
    await expect(win.getByText("Replaces c1 with the name in: one, two (and this draft).")).toBeVisible();
    await win.getByRole("textbox", { name: "Destination name" }).fill("Build room");
    await win.getByRole("button", { name: "Save name" }).click();

    await expect(win.getByLabel("Discord destination")).toHaveValue("alias:Build room");
    await expect.poll(() => chatops("one")).toEqual([{ transport: "discord", alias: "Build room" }]);
    await expect.poll(() => chatops("two")).toEqual([{ transport: "discord" }, { transport: "discord", alias: "Build room" }]);
    expect(await chatops("other")).toEqual([{ transport: "discord", channel: "c9" }]);

    // An id Bean has never seen still works, with no Name it.
    await win.locator(".bean-routines-row", { hasText: "other" }).click();
    await expect(win.getByLabel("Discord channel id")).toHaveValue("c9");
    await expect(win.getByRole("button", { name: "Name it" })).toHaveCount(0);
  } finally {
    await app.close();
    await home.cleanup();
  }
});
