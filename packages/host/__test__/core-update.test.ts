// The core self-update engine (#837) with an injected fetch and command runner over a real temp
// install root (versions/<ver> behind `current` / `previous`).
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { busyWork, RELEASES_URL, updateCore, type BusyItem, type CoreUpdateDeps } from "../src/core-update.js";
import type { TaskJob } from "../src/task-status.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const TAR = Buffer.from("pretend tarball");
const ENTRY = "packages/host/dist/bean-core.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function setup(opts: { sig?: string | null; preflight?: string | Error; busy?: BusyItem[]; tag?: string } = {}) {
  root = mkdtempSync(join(tmpdir(), "bean-core-update-"));
  mkdirSync(join(root, "versions", "0.1.0"), { recursive: true });
  symlinkSync("versions/0.1.0", join(root, "current"));
  const tag = opts.tag ?? "v0.2.0";
  const ver = tag.slice(1);
  const sig = opts.sig === undefined ? sign(null, TAR, privateKey).toString("base64") : opts.sig;
  const assets = [{ name: `bean-core-${ver}.tar.gz`, browser_download_url: "https://dl/tar" }];
  if (sig !== null) assets.push({ name: `bean-core-${ver}.tar.gz.sig`, browser_download_url: "https://dl/sig" });
  const bodies: Record<string, string | Buffer> = {
    [RELEASES_URL]: JSON.stringify({ tag_name: tag, body: "", assets }),
    "https://dl/tar": TAR,
    "https://dl/sig": sig ?? "",
  };
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(bodies[String(url)] ?? "", { status: bodies[String(url)] === undefined ? 404 : 200 }));
  const calls: string[] = [];
  const run = vi.fn(async (cmd: string, args: string[]) => {
    calls.push(cmd);
    if (cmd === "tar") {
      // What the real tarball holds: bean-core-<ver>/ in the checkout layout.
      const entry = join(args[3]!, `bean-core-${ver}`, ENTRY);
      mkdirSync(join(entry, ".."), { recursive: true });
      writeFileSync(entry, "");
      return "";
    }
    const p = opts.preflight ?? `bean-core ${ver} contract 1\n`;
    if (p instanceof Error) throw p;
    return p;
  });
  const latch = { close: vi.fn(() => calls.push("close")), open: vi.fn(() => calls.push("open")), busy: vi.fn(() => opts.busy ?? []) };
  const deps: CoreUpdateDeps = { root, currentVersion: "0.1.0", latch, fetch: fetch as typeof globalThis.fetch, run, publicKeyPem: PEM, node: "/node" };
  return { deps, latch, calls, link: (name: string) => readlinkSync(join(root, name)) };
}

test("idle: verified, unpacked, preflighted, then the latch closes and the links flip (it stays closed for the exit)", async () => {
  const { deps, latch, calls, link } = setup();
  expect(await updateCore(false, deps)).toEqual({ status: "updated", from: "0.1.0", version: "0.2.0", stopped: [] });
  expect(calls).toEqual(["tar", "/node", "close"]);
  expect(latch.open).not.toHaveBeenCalled();
  expect(link("current")).toBe("versions/0.2.0");
  expect(link("previous")).toBe("versions/0.1.0");
  expect(existsSync(join(root, "versions", "0.2.0", ENTRY))).toBe(true);
  expect(readdirSync(join(root, "versions"))).toEqual(["0.1.0", "0.2.0"]); // the temp dir is gone
});

test("busy and not forced: refuses with the list and reopens admission; links untouched", async () => {
  const busy = [{ kind: "delegate", name: "bean" }];
  const { deps, latch, link } = setup({ busy });
  expect(await updateCore(false, deps)).toEqual({ status: "busy", version: "0.2.0", busy });
  expect(latch.close).toHaveBeenCalledOnce();
  expect(latch.open).toHaveBeenCalledOnce();
  expect(link("current")).toBe("versions/0.1.0");
});

test("busy and forced: flips anyway and reports what it stops", async () => {
  const busy = [{ kind: "live", name: "Claude · bean" }];
  const { deps, latch, link } = setup({ busy });
  expect(await updateCore(true, deps)).toMatchObject({ status: "updated", stopped: busy });
  expect(latch.open).not.toHaveBeenCalled();
  expect(link("current")).toBe("versions/0.2.0");
});

test.each([
  ["a bad signature", { sig: sign(null, Buffer.from("other"), privateKey).toString("base64") }, /signature doesn't verify/],
  ["a missing signature", { sig: null }, /missing bean-core-0\.2\.0\.tar\.gz\.sig/],
])("%s is a hard stop before anything is unpacked", async (_name, opts, message) => {
  const { deps, latch, calls } = setup(opts);
  expect(await updateCore(true, deps)).toMatchObject({ status: "error", message: expect.stringMatching(message) });
  expect(calls).toEqual([]);
  expect(latch.close).not.toHaveBeenCalled();
  expect(readdirSync(join(root, "versions"))).toEqual(["0.1.0"]);
});

test.each([
  ["a failing preflight", { preflight: new Error("node failed: SyntaxError") }, /preflight: node failed/],
  ["a version other than promised", { preflight: "bean-core 0.1.9 contract 1" }, /0\.1\.9, not 0\.2\.0/],
  ["a contract mismatch on a shell's update", { preflight: "bean-core 0.2.0 contract 2" }, /contract v2/],
])("%s refuses before the latch and removes the unpacked copy", async (_name, opts, message) => {
  const { deps, latch, link } = setup(opts);
  expect(await updateCore(true, { ...deps, contract: 1 })).toMatchObject({ status: "error", message: expect.stringMatching(message) });
  expect(latch.close).not.toHaveBeenCalled();
  expect(link("current")).toBe("versions/0.1.0");
  expect(existsSync(join(root, "versions", "0.2.0"))).toBe(false);
});

test("the box's own update (no contract given) accepts a new contract — the recovery path", async () => {
  const { deps } = setup({ preflight: "bean-core 0.2.0 contract 2" });
  expect(await updateCore(false, deps)).toMatchObject({ status: "updated" });
});

test("a release that isn't newer is up to date: nothing is downloaded", async () => {
  const { deps, calls } = setup({ tag: "v0.1.0" });
  expect(await updateCore(false, deps)).toEqual({ status: "up-to-date", version: "0.1.0" });
  expect(deps.fetch).toHaveBeenCalledOnce();
  expect(calls).toEqual([]);
});

test("a core not installed by install.sh refuses without touching the network", async () => {
  const { deps } = setup();
  rmSync(join(root, "current"));
  expect(await updateCore(true, deps)).toMatchObject({ status: "error", message: expect.stringMatching(/install\.sh/) });
  expect(deps.fetch).not.toHaveBeenCalled();
});

test("a failure while switching reopens admission", async () => {
  const { deps, latch } = setup();
  latch.busy.mockImplementation(() => { throw new Error("boom"); });
  expect(await updateCore(true, deps)).toMatchObject({ status: "error", message: expect.stringMatching(/boom/) });
  expect(latch.open).toHaveBeenCalledOnce();
});

test("busyWork: running jobs plus live run records the host doesn't already list", () => {
  const job = (id: string, kind: TaskJob["kind"], name: string, state: TaskJob["state"] = "running"): TaskJob =>
    ({ id, kind, name, line: "", detail: "", startedAt: 0, state });
  const run = (id: string, projectPath: string) => ({ id, projectPath, pid: 1, createdAt: "" });
  expect(busyWork(
    [job("t1", "delegate", "bean"), job("live:s1", "live", "Claude · bean"), job("x", "chat", "Chat", "failed")],
    [run("t1", "/p/bean"), run("s1", "/p/bean"), run("r9", "/p/other")],
  )).toEqual([{ kind: "delegate", name: "bean" }, { kind: "live", name: "Claude · bean" }, { kind: "run", name: "other" }]);
  // A sprout admitted to a slot shows before its bubble does, and once (not twice) after.
  const bubble = { ...job("routine:a", "routine", "Morning"), routine: "a" };
  expect(busyWork([bubble], [], ["a", "b"])).toEqual([{ kind: "routine", name: "Morning" }, { kind: "routine", name: "b" }]);
});
