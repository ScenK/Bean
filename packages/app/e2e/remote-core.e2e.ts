import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from "@bean/host";
import { launchBean } from "./fixtures/launch-app.js";

type Bean = { bean: { openComponent: (k: string) => Promise<void> } };

// A stand-in for `ssh <host> bean-core attach`: speaks the attach wire (4-byte length + JSON) on its
// stdio. A chat message drives it: "drop" kills the tunnel mid-turn, "takeover" is another machine
// attaching. Each spawn logs its argv. `<log>.core` (JSON, optional) is the core's update state (#838):
// its version, the latest release, its busy list; mode "old" predates the update ops, "gone" never
// comes back after an update.
const fakeSsh = (log: string): string => `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const coreFile = ${JSON.stringify(log)} + ".core";
const core = () => { try { return JSON.parse(readFileSync(coreFile, "utf8")); } catch { return {}; } };
if (core().down) process.exit(1);
const send = (m, then) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); process.stdout.write(Buffer.concat([h, b]), then); };
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const n = buf.readUInt32BE(0);
    const m = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    if (m.type === "attach") send({ type: "attached", handshake: { contract: ${CONTRACT_VERSION}, core: core().version ?? "test", platform: "linux", capabilities: [] }, generation: 1, clientId: -1 });
    if (m.type === "detach") process.exit(0);
    if (m.type !== "call") continue;
    appendFileSync(${JSON.stringify(log)} + ".calls", JSON.stringify({ op: m.op, args: m.args }) + "\\n");
    if (m.op === "coreUpdateStatus" || m.op === "coreUpdateApply") {
      const c = core();
      if (c.mode === "old") { send({ type: "result", id: m.id, ok: false, error: m.op + " is not allowed over a remote attach." }); continue; }
      const busy = c.busy ?? [];
      if (m.op === "coreUpdateStatus") { send({ type: "result", id: m.id, ok: true, value: { current: c.version, latest: c.latest, busy } }); continue; }
      if (busy.length > 0 && !m.args[0]) { send({ type: "result", id: m.id, ok: true, value: { status: "busy", version: c.latest, busy } }); continue; }
      writeFileSync(coreFile, JSON.stringify(c.mode === "gone" ? { ...c, down: true } : { version: c.latest }));
      send({ type: "result", id: m.id, ok: true, value: { status: "updated", from: c.version, version: c.latest, stopped: busy } }, () => process.exit(0));
      continue;
    }
    if (m.op === "chat") {
      const text = m.args[0].message;
      if (text === "drop") process.exit(1);
      if (text === "takeover") { send({ type: "revoked" }); process.exit(0); }
      send({ type: "result", id: m.id, ok: true, value: { reply: "remote echo: " + text } });
      continue;
    }
    const config = {
      openaiApiKey: "", apiKeySet: true, model: "gpt-remote", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false,
      reasoningEffort: "", routineDigestContext: false, disabledClis: [], webSearch: false, autoMemory: true, gitName: "", gitEmail: "",
      paths: { config: "/srv/.bean/config.json", skills: "/srv/.bean/skills", projects: "/srv/.bean/projects.json", persona: "/srv/.bean/persona.json" },
    };
    const value = m.op === "getModel" ? "gpt-remote" : m.op === "getConfig" ? config
      : ["listSkills", "listProjects", "availableClis", "availableModels", "detectedClis"].includes(m.op) ? [] : undefined;
    send({ type: "result", id: m.id, ok: true, value });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

// #811: a shell attached to a remote core over ssh — host badge, a chat turn over the wire, the
// reconnect bar with a read-only composer, and the takeover banner that waits for Take back.
test("remote core: chat over ssh, reconnect bar, takeover banner", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "bean-e2e-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const bin = await mkdtemp(join(tmpdir(), "bean-e2e-bin-"));
  const log = join(bin, "ssh.log");
  await writeFile(join(bin, "ssh"), fakeSsh(log));
  await chmod(join(bin, "ssh"), 0o755);
  await writeFile(join(userDataDir, "cores.json"), JSON.stringify({ selected: "r1", cores: [{ id: "r1", host: "me@box" }] }));
  const app = await launchBean({ HOME: homeDir, PATH: `${bin}:${process.env.PATH ?? ""}` }, userDataDir);
  const errors: string[] = [];
  const watch = (p: Page): void => { p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`)); };
  app.on("window", watch);
  try {
    const avatar = await app.firstWindow();
    watch(avatar);
    await expect(avatar.locator("#bean")).toHaveAttribute("title", "Bean on me@box");
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as Bean).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await expect(chat.locator(".bean-chat-host")).toHaveText("me@box");
    const composer = chat.locator(".bean-input--composer");

    await composer.fill("hi");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("remote echo: hi");

    // The tunnel dies: the reconnect bar, a read-only composer; the next ssh attaches again.
    await composer.fill("drop");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-core-bar")).toBeVisible();
    await expect(chat.locator(".bean-core-bar")).toBeHidden({ timeout: 10_000 });
    await expect(composer).not.toHaveAttribute("readonly");
    await composer.fill("again");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("remote echo: again");

    // Another machine takes over: the banner stays (no reconnect of its own) until Take back.
    await composer.fill("takeover");
    await chat.locator(".bean-send").click();
    const bar = chat.locator(".bean-core-bar");
    await expect(bar).toContainText("Attached from another machine");
    await expect(composer).toHaveAttribute("readonly", "");
    const spawns = (await readFile(log, "utf8")).trim().split("\n");
    await chat.waitForTimeout(2_500); // past the first reconnect backoff
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(spawns.length);
    await bar.getByRole("button", { name: "Take back" }).click();
    await expect(bar).toBeHidden();

    // Fixed argv: key auth only, host keys checked, the host after `--`.
    const argv = JSON.parse(spawns[0]!) as string[];
    expect(argv).toEqual(expect.arrayContaining(["BatchMode=yes", "StrictHostKeyChecking=yes"]));
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "me@box", "bean-core", "attach"]);
    expect(errors).toEqual([]);
    expect(existsSync(join(homeDir, ".bean"))).toBe(false);
  } finally {
    await app.close().catch(() => {});
    await Promise.allSettled([homeDir, userDataDir, bin].map((d) => rm(d, { recursive: true, force: true })));
  }
});

// #812: a Linux core — no terminal pane, no system controls or Terminal/Editor apps in Settings, and a
// Settings save is a patch that never carries (so never clears) the API key.
test("remote core: capability-gated chat and key-preserving Settings", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "bean-e2e-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const bin = await mkdtemp(join(tmpdir(), "bean-e2e-bin-"));
  const log = join(bin, "ssh.log");
  await writeFile(join(bin, "ssh"), fakeSsh(log));
  await chmod(join(bin, "ssh"), 0o755);
  await writeFile(join(userDataDir, "cores.json"), JSON.stringify({ selected: "r1", cores: [{ id: "r1", host: "me@box" }] }));
  const app = await launchBean({ HOME: homeDir, PATH: `${bin}:${process.env.PATH ?? ""}` }, userDataDir);
  try {
    const avatar = await app.firstWindow();
    await expect(avatar.locator("#bean")).toHaveAttribute("title", "Bean on me@box");
    const open = async (kind: string): Promise<Page> => {
      const [w] = await Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate((k) => (window as unknown as Bean).bean.openComponent(k), kind),
      ]);
      await w.waitForLoadState("domcontentloaded");
      return w;
    };

    const chat = await open("chat");
    await expect(chat.locator(".bean-chat-host")).toHaveText("me@box");
    await expect(chat.locator(".bean-chat-term-toggle")).toHaveCount(0);
    await chat.keyboard.press("Control+`");
    await expect(chat.locator(".bean-term")).toHaveCount(0);

    const settings = await open("settings");
    const key = settings.locator('input[type="password"]');
    await expect(key).toHaveAttribute("placeholder", "Saved on me@box — type to replace");
    await expect(key).toHaveValue("");
    await expect(settings.locator(".bean-settings-row-label", { hasText: "Model name" })).toBeVisible();
    for (const gone of ["System controls", "Terminal", "Editor"]) {
      await expect(settings.locator(".bean-settings-row-label", { hasText: new RegExp(`^${gone}$`) })).toHaveCount(0);
    }
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("button", { name: "Saved ✓" })).toBeVisible();
    const calls = (await readFile(`${log}.calls`, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { op: string; args: unknown[] });
    const saves = calls.filter((c) => c.op === "saveConfig");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.args[0]).toMatchObject({ model: "gpt-remote" });
    for (const k of ["openaiApiKey", "terminalApp", "editorApp", "systemControls"]) expect(saves[0]!.args[0]).not.toHaveProperty(k);
  } finally {
    await app.close().catch(() => {});
    await Promise.allSettled([homeDir, userDataDir, bin].map((d) => rm(d, { recursive: true, force: true })));
  }
});

// #838: updating the remote core from About — an older core's refusal, the busy list, apply → the core
// restarts → the reattached handshake's version, and a core that never comes back.
test("remote core: update the core from About", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "bean-e2e-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const bin = await mkdtemp(join(tmpdir(), "bean-e2e-bin-"));
  const log = join(bin, "ssh.log");
  const setCore = (state: object): Promise<void> => writeFile(`${log}.core`, JSON.stringify(state));
  await writeFile(join(bin, "ssh"), fakeSsh(log));
  await chmod(join(bin, "ssh"), 0o755);
  await setCore({ version: "1.0.0", mode: "old" });
  await writeFile(join(userDataDir, "cores.json"), JSON.stringify({ selected: "r1", cores: [{ id: "r1", host: "me@box" }] }));
  const app = await launchBean({ HOME: homeDir, PATH: `${bin}:${process.env.PATH ?? ""}` }, userDataDir);
  try {
    const avatar = await app.firstWindow();
    await expect(avatar.locator("#bean")).toHaveAttribute("title", "Bean on me@box");
    const [about] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as Bean).bean.openComponent("about")),
    ]);
    await about.waitForLoadState("domcontentloaded");
    const section = about.locator(".bean-about-core");
    await expect(section.locator(".bean-about-version")).toHaveText("Core on me@box · v1.0.0");

    // A core from before the update ops refuses them like any unknown op.
    await section.getByRole("button", { name: "Check core for updates" }).click();
    await expect(section).toContainText("This core predates remote update — run install.sh on it once.");

    // Busy: the list, then Stop them and update → the core restarts on the new version.
    await setCore({ version: "1.0.0", latest: "1.1.0", busy: ["delegate bean", "delegate api", "sprout Morning"] });
    await section.getByRole("button", { name: "Check again" }).click();
    await expect(section).toContainText("Core version 1.1.0 is available.");
    await expect(section).toContainText("Running on the core: 2 delegates, sprout Morning");
    await expect(section.getByRole("button", { name: "Not now" })).toBeVisible();
    await section.getByRole("button", { name: "Stop them and update" }).click();
    await expect(section).toContainText("Core updated to v1.1.0.", { timeout: 15_000 });
    await expect(section.locator(".bean-about-version")).toHaveText("Core on me@box · v1.1.0");
    const applies = (await readFile(`${log}.calls`, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { op: string; args: unknown[] })
      .filter((c) => c.op === "coreUpdateApply");
    expect(applies.map((c) => c.args)).toEqual([[true]]);

    // A core that doesn't come back within two minutes: the rollback command.
    await setCore({ version: "1.1.0", latest: "1.2.0", mode: "gone" });
    await section.getByRole("button", { name: "Check again" }).click();
    await about.clock.install();
    await section.getByRole("button", { name: "Update core" }).click();
    await expect(section.getByRole("button", { name: "Restarting core…" })).toBeVisible();
    await about.clock.fastForward(2 * 60_000 + 1_000);
    await expect(section).toContainText("Core didn't come back after updating.");
    await expect(section.locator(".bean-cores-command")).toHaveText("ssh me@box bean-core rollback");
  } finally {
    await app.close().catch(() => {});
    await Promise.allSettled([homeDir, userDataDir, bin].map((d) => rm(d, { recursive: true, force: true })));
  }
});
