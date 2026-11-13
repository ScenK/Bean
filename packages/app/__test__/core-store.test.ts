import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCore, coreCli, coreFile, coreLabel, loadCoreChoice, oneTimeCommand, parseRemoteCore, saveCoreChoice, sshArgs } from "../src/core-store.js";

describe("core choice (#810, #811)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-core-store-"));

  it("first run: a Mac runs its local core, elsewhere no core", async () => {
    const file = coreFile(join(dir, "none"));
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: "local", cores: [] });
    expect(await loadCoreChoice(file, "win32")).toEqual({ selected: null, cores: [] });
  });

  it("keeps a saved choice; an unknown id is no core; corrupt falls back", async () => {
    const file = coreFile(dir);
    await saveCoreChoice(file, { selected: null, cores: [] });
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: null, cores: [] });
    await saveCoreChoice(file, { selected: "local", cores: [] });
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: "local", cores: [] });
    // Local is macOS-only (#813): a cores.json carried to Windows boots with no core.
    expect(await loadCoreChoice(file, "win32")).toEqual({ selected: null, cores: [] });
    await writeFile(file, JSON.stringify({ selected: "remote-1" }));
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: null, cores: [] });
    await writeFile(file, "{not json");
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: "local", cores: [] });
  });

  it("selects a saved remote core and drops malformed entries", async () => {
    const file = coreFile(dir);
    const good = { id: "a", host: "me@box", container: "bean" };
    await writeFile(file, JSON.stringify({ selected: "a", cores: [good, { id: "b", host: "-oProxyCommand=x" }, { host: "me@x" }] }));
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: "a", cores: [good] });
  });
});

describe("remote core entries", () => {
  it("accepts user@host and an optional container; refuses option and shell characters", () => {
    expect(parseRemoteCore(" me@box.lan ", "")).toEqual({ host: "me@box.lan" });
    expect(parseRemoteCore("box", "bean-core_1")).toEqual({ host: "box", container: "bean-core_1" });
    for (const bad of ["-oProxyCommand=evil", "me@box; rm -rf ~", "me@box bean", "", "me@", "$(x)@box", "-oX=y@box"]) {
      expect(parseRemoteCore(bad, ""), bad).toHaveProperty("error");
    }
    expect(parseRemoteCore("me@box", "x; rm")).toHaveProperty("error");
    expect(parseRemoteCore("me@box", "-it")).toHaveProperty("error");
  });

  it("adds once per host + container, and labels them", () => {
    const first = addCore({ selected: null, cores: [] }, { host: "me@box" });
    const again = addCore(first.choice, { host: "me@box" });
    expect(again.core.id).toBe(first.core.id);
    expect(again.choice.cores).toHaveLength(1);
    expect(addCore(first.choice, { host: "me@box", container: "c" }).choice.cores).toHaveLength(2);
    expect(coreLabel({ host: "me@box", container: "c" })).toBe("me@box · c");
  });

  it("ssh argv: fixed options, key auth only, host keys checked, `--` before the host", () => {
    const args = sshArgs({ host: "me@box", container: "bean" });
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "me@box", "docker", "exec", "-i", "bean", "bean-core", "attach"]);
    expect(sshArgs({ host: "box" }).slice(-3)).toEqual(["box", "bean-core", "attach"]);
  });
});

describe("coreCli (#838)", () => {
  it("runs bean-core on the core's machine, or in its container", () => {
    expect(coreCli({ host: "me@box" })).toBe("ssh me@box");
    expect(coreCli({ host: "me@box", container: "bean" })).toBe("ssh me@box docker exec -i bean");
  });
});

describe("oneTimeCommand (#813)", () => {
  it("is ssh-copy-id on a Mac and the PowerShell equivalent on Windows", () => {
    expect(oneTimeCommand({ host: "me@box" }, "darwin")).toBe("ssh-copy-id me@box");
    expect(oneTimeCommand({ host: "me@box" }, "win32"))
      .toBe('type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh me@box "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"');
  });
});
