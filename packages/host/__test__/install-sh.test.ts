// install.sh (#836) run against stubs: a fake tarball whose bundle prints its version, and fake
// launchctl / systemctl / sudo / uname on PATH. Root-owned paths go under BEAN_CORE_SYSROOT.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const ENTRY = "packages/host/dist/bean-core.js";
let t = "";
afterEach(() => { if (t) rmSync(t, { recursive: true, force: true }); });

function setup(os: "Darwin" | "Linux", nodeVersion?: string): { home: string; root: string; sys: string; run: (cmd: string, ...args: string[]) => ReturnType<typeof spawnSync> } {
  t = mkdtempSync(join(tmpdir(), "bean-install-"));
  // Quote, ampersand, angle brackets, % and $ — every generated file has to escape them.
  const home = join(t, "o'brien & <co> %x$y");
  const bin = join(t, "bin");
  const sys = join(t, "sys");
  mkdirSync(home);
  mkdirSync(bin);
  const stub = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  if (nodeVersion) stub("node", `echo ${nodeVersion}`);
  else symlinkSync(process.execPath, join(bin, "node"));
  const start = `node "$HOME/.local/share/bean-core/current/${ENTRY}"`;
  stub("uname", `echo ${os}`);
  stub("sudo", `[ "$1" = -v ] && exit 0\nexec "$@"`);
  stub("launchctl", `echo "launchctl $*" >> "${t}/calls"\ncase $1 in bootstrap|kickstart) ${start} >> "$HOME/Library/Logs/bean-core.log";; esac`);
  stub("systemctl", `echo "systemctl $*" >> "${t}/calls"\n[ "$1" = restart ] && ${start} > "${t}/journal"\nexit 0`);
  stub("journalctl", `cat "${t}/journal"`);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, BEAN_CORE_SYSROOT: sys };
  const run = (cmd: string, ...args: string[]) => spawnSync("/bin/sh", [cmd, ...args], { env, encoding: "utf8" });
  return { home, root: join(home, ".local/share/bean-core"), sys, run };
}

/** An extracted bean-core-<ver>/ whose bundle prints `--version` and a boot line naming its version. */
function tarball(ver: string): string {
  const dir = join(t, `bean-core-${ver}`);
  mkdirSync(join(dir, dirname(ENTRY)), { recursive: true });
  cpSync(script, join(dir, "install.sh"));
  writeFileSync(join(dir, ENTRY),
    `if (process.argv[2] === "--version") { console.log("bean-core ${ver} contract 1"); process.exit(0); }\nconsole.log("bean-core on: ${ver}");\n`);
  return join(dir, "install.sh");
}

// Each case spawns the installer and several node processes: well past vitest's 5 s default on a loaded runner.
describe("install.sh", { timeout: 30_000 }, () => {
  it("macOS: installs, upgrades, rolls back and uninstalls", () => {
    const { home, root, sys, run } = setup("Darwin");
    const first = run(tarball("1.0.0"), "--tz", "America/Toronto");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("bean-core on: 1.0.0");
    expect(first.stdout).toMatch(/Add this core in Bean: \S+@\S+/);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
    expect(existsSync(join(root, "previous"))).toBe(false);
    const config = join(home, ".bean/config.json");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ openaiApiKey: "" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    const plist = readFileSync(join(home, "Library/LaunchAgents/dev.bean.core.plist"), "utf8");
    expect(plist).toContain("o'brien &amp; &lt;co&gt; %x$y/.local/share/bean-core/current/packages/host/dist/bean-core.js");
    expect(plist).toContain("<key>TZ</key><string>America/Toronto</string>");

    // The wrapper's quoting survives the odd HOME: it runs the current version.
    const wrapper = join(sys, "usr/local/bin/bean-core");
    expect(spawnSync(wrapper, ["--version"], { encoding: "utf8" }).stdout).toBe("bean-core 1.0.0 contract 1\n");

    const second = run(tarball("2.0.0"), "--tz", "America/Toronto");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("bean-core on: 2.0.0");
    expect(readlinkSync(join(root, "current"))).toBe("versions/2.0.0");
    expect(readlinkSync(join(root, "previous"))).toBe("versions/1.0.0");

    const back = spawnSync("/bin/sh", [wrapper, "rollback"], { env: { HOME: home, PATH: `${join(t, "bin")}:/usr/bin:/bin` }, encoding: "utf8" });
    expect(back.status).toBe(0);
    expect(back.stdout).toContain("bean-core on: 1.0.0");
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
    expect(readlinkSync(join(root, "previous"))).toBe("versions/2.0.0");
    expect(readFileSync(join(t, "calls"), "utf8")).toMatch(/kickstart -k gui\/\d+\/dev\.bean\.core/);

    // `bean-core update` with no core running (#837) flips the links itself, then restarts through this.
    const restarted = run(join(root, "current/install.sh"), "--restart");
    expect(restarted.status).toBe(0);
    expect(restarted.stdout).toContain("bean-core on: 1.0.0");

    const gone = run(join(root, "current/install.sh"), "--uninstall");
    expect(gone.status).toBe(0);
    expect(gone.stdout).toContain("Kept ~/.bean");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(wrapper)).toBe(false);
    expect(existsSync(join(home, "Library/LaunchAgents/dev.bean.core.plist"))).toBe(false);
    expect(existsSync(config)).toBe(true);
  });

  it("Linux: writes an escaped systemd unit and restarts it", () => {
    const { home, sys, run } = setup("Linux");
    const r = run(tarball("1.0.0"), "--tz=Europe/Berlin");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bean-core on: 1.0.0");
    const unit = readFileSync(join(sys, "etc/systemd/system/bean-core.service"), "utf8");
    const escaped = "o'brien & <co> %%x$$y";
    expect(unit).toContain(`WorkingDirectory=${home.replace("%", "%%")}\n`);
    expect(unit).toContain('Environment="TZ=Europe/Berlin"');
    expect(unit).toMatch(new RegExp(`ExecStart=".+/node" ".+${escaped.replace(/\$/g, "\\$")}/\\.local/share/bean-core/current/packages/host/dist/bean-core\\.js"`));
    expect(unit).toContain("Restart=always");
    expect(readFileSync(join(t, "calls"), "utf8")).toContain("systemctl daemon-reload\nsystemctl enable --quiet bean-core\nsystemctl restart bean-core");

    expect(run(join(home, ".local/share/bean-core/current/install.sh"), "--uninstall").status).toBe(0);
    expect(existsSync(join(sys, "etc/systemd/system/bean-core.service"))).toBe(false);
  });

  it("an old Node or a bad time zone stops before changing anything", () => {
    const { home, run } = setup("Darwin", "22.1.0");
    const old = run(tarball("1.0.0"), "--tz", "UTC");
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("needs Node 24 or newer (found: 22.1.0");
    expect(old.stderr).toContain("brew install node");
    rmSync(join(t, "bin/node"));
    symlinkSync(process.execPath, join(t, "bin/node"));
    for (const tz of ["UTC; rm -rf /", "Mars/Olympus_Mons"]) {
      const bad = run(join(t, "bean-core-1.0.0/install.sh"), "--tz", tz);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/time zone/);
    }
    expect(existsSync(join(home, ".local"))).toBe(false);
    expect(existsSync(join(home, ".bean"))).toBe(false);
  });
});
