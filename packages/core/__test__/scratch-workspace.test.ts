import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareScratchWorkspace, scratchDir, slugForUrl } from "../src/scratch-workspace.js";
import type { ScratchSpawnFn, FetchTextFn } from "../src/scratch-workspace.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-scratch-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("slugForUrl strips the scheme and sanitizes the path into a filesystem-safe slug", () => {
  expect(slugForUrl("https://github.com/etcd-io/etcd")).toBe("github.com-etcd-io-etcd");
  expect(slugForUrl("https://newsletter.pragmaticengineer.com/p/ai-tooling/")).toBe(
    "newsletter.pragmaticengineer.com-p-ai-tooling",
  );
});

test("a repo URL is cloned (shallow) into the scratch dir", async () => {
  const spawnFn = vi.fn<ScratchSpawnFn>(async () => {});
  const fetchText: FetchTextFn = vi.fn();
  const dest = await prepareScratchWorkspace("https://github.com/etcd-io/etcd", "repo", dir, spawnFn, fetchText);
  expect(dest).toBe(join(scratchDir(dir), "github.com-etcd-io-etcd"));
  expect(spawnFn).toHaveBeenCalledWith(
    "git",
    ["clone", "--depth", "1", "https://github.com/etcd-io/etcd", dest],
    scratchDir(dir),
  );
  expect(fetchText).not.toHaveBeenCalled();
});

test("a page URL is fetched, extracted, and written into the scratch dir", async () => {
  const spawnFn: ScratchSpawnFn = vi.fn();
  const fetchText: FetchTextFn = async () => "<html><body><p>Hello world</p></body></html>";
  const url = "https://newsletter.pragmaticengineer.com/p/ai-tooling";
  const dest = await prepareScratchWorkspace(url, "page", dir, spawnFn, fetchText);
  expect(dest).toBe(scratchDir(dir));
  expect(spawnFn).not.toHaveBeenCalled();
  const written = await readFile(join(scratchDir(dir), `${slugForUrl(url)}.md`), "utf8");
  expect(written).toBe("Hello world");
});

test("a failed clone rejects", async () => {
  const spawnFn: ScratchSpawnFn = async () => { throw new Error("git clone failed"); };
  await expect(prepareScratchWorkspace("https://github.com/x/y", "repo", dir, spawnFn, vi.fn())).rejects.toThrow(
    "git clone failed",
  );
});
