import { expect, test, vi } from "vitest";
import { sniffUrl } from "../src/url-sniff.js";
import type { FetchHeadFn } from "../src/url-sniff.js";
import type { SpawnSyncFn } from "../src/launcher.js";

test("a URL git ls-remote can read is a repo", async () => {
  const spawnSyncFn: SpawnSyncFn = vi.fn(() => ({ stdout: "abc123\tHEAD\n" }));
  const fetchHead: FetchHeadFn = vi.fn();
  expect(await sniffUrl("https://github.com/etcd-io/etcd", spawnSyncFn, fetchHead)).toBe("repo");
  expect(fetchHead).not.toHaveBeenCalled();
});

test("a URL that fails ls-remote but returns HTML is a page", async () => {
  const spawnSyncFn: SpawnSyncFn = () => ({ stdout: "" });
  const fetchHead: FetchHeadFn = async () => ({ ok: true, contentType: "text/html; charset=utf-8" });
  expect(await sniffUrl("https://newsletter.pragmaticengineer.com/p/ai-tooling", spawnSyncFn, fetchHead)).toBe("page");
});

test("a URL that fails both checks is unknown", async () => {
  const spawnSyncFn: SpawnSyncFn = () => ({ stdout: "" });
  const fetchHead: FetchHeadFn = async () => ({ ok: false, contentType: null });
  expect(await sniffUrl("https://unreachable.example", spawnSyncFn, fetchHead)).toBe("unknown");
});

test("a thrown git spawn error falls through to the page check", async () => {
  const spawnSyncFn: SpawnSyncFn = () => { throw new Error("git ENOENT"); };
  const fetchHead: FetchHeadFn = async () => ({ ok: true, contentType: "text/html" });
  expect(await sniffUrl("https://example.com", spawnSyncFn, fetchHead)).toBe("page");
});

test("a thrown fetch error resolves to unknown", async () => {
  const spawnSyncFn: SpawnSyncFn = () => ({ stdout: "" });
  const fetchHead: FetchHeadFn = async () => { throw new Error("network down"); };
  expect(await sniffUrl("https://example.com", spawnSyncFn, fetchHead)).toBe("unknown");
});

test("a non-HTML content type is not treated as a page", async () => {
  const spawnSyncFn: SpawnSyncFn = () => ({ stdout: "" });
  const fetchHead: FetchHeadFn = async () => ({ ok: true, contentType: "application/pdf" });
  expect(await sniffUrl("https://example.com/file.pdf", spawnSyncFn, fetchHead)).toBe("unknown");
});
