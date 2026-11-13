#!/usr/bin/env node
// Packs the built bean-core (#835) as release/bean-core-<ver>.tar.gz: one artifact for macOS and
// Linux (no native modules). Keeps the checkout layout under bean-core-<ver>/ because the bundle
// finds .bean at ../../../.bean and the bots at packages/<bot>/dist beside it — same set as the
// Dockerfile — plus the installer (#836) at the top, from packages/host/install.sh. Run after
// `pnpm build` (or `pnpm dist:mac`); `pnpm pack:core` does both.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
// The version bean-core reports: esbuild.config.mjs defines it from the same file.
const { version } = JSON.parse(readFileSync(join(repo, "packages/app/package.json"), "utf8"));
const name = `bean-core-${version}`;
const files = ["packages/host/dist/bean-core.js", "packages/discord/dist", "packages/teams/dist", ".bean"];

const stage = mkdtempSync(join(tmpdir(), "bean-core-pack-"));
try {
  for (const f of files) {
    const from = join(repo, f);
    if (!existsSync(from)) throw new Error(`${f} is missing — run pnpm build first.`);
    const to = join(stage, name, f);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  const entry = join(stage, name, files[0]);
  chmodSync(entry, 0o755);
  const installer = join(stage, name, "install.sh");
  cpSync(join(repo, "packages/host/install.sh"), installer);
  chmodSync(installer, 0o755);

  // The preflight must work on a box with no ~/.bean, TZ or config (the installer's first call).
  const home = join(stage, "home");
  mkdirSync(home);
  const out = execFileSync(process.execPath, [entry, "--version"], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
  assert.ok(out.startsWith(`bean-core ${version} contract `), `--version printed ${JSON.stringify(out)}`);
  assert.ok(!existsSync(join(home, ".bean")), "--version must not create ~/.bean");

  const outDir = join(repo, "release");
  mkdirSync(outDir, { recursive: true });
  const tarball = join(outDir, `${name}.tar.gz`);
  // COPYFILE_DISABLE + --no-xattrs: macOS tar would otherwise add AppleDouble ._ files and pax xattr
  // headers (com.apple.provenance), which GNU tar warns about on every file when extracting.
  execFileSync("tar", ["--no-xattrs", "-czf", tarball, "-C", stage, name], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: "inherit" });
  console.log(`packed ${tarball} (${out.trim()})`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
