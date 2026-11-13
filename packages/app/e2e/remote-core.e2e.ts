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
// attaching. Each spawn logs its argv.
const fakeSsh = (log: string): string => `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); process.stdout.write(Buffer.concat([h, b])); };
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const n = buf.readUInt32BE(0);
    const m = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    if (m.type === "attach") send({ type: "attached", handshake: { contract: ${CONTRACT_VERSION}, core: "test", platform: "linux", capabilities: [] }, generation: 1, clientId: -1 });
    if (m.type === "detach") process.exit(0);
    if (m.type !== "call") continue;
    if (m.op === "chat") {
      const text = m.args[0].message;
      if (text === "drop") process.exit(1);
      if (text === "takeover") { send({ type: "revoked" }); process.exit(0); }
      send({ type: "result", id: m.id, ok: true, value: { reply: "remote echo: " + text } });
      continue;
    }
    const value = m.op === "getModel" ? "gpt-remote" : ["listSkills", "listProjects", "availableClis", "availableModels"].includes(m.op) ? [] : undefined;
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
