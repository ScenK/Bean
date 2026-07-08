import { expect, test, vi } from "vitest";
import { isSafeRemoteUrl, sniffUrl } from "../src/url-sniff.js";
import type { FetchHeadFn, GitLsRemoteFn } from "../src/url-sniff.js";

test("a URL git ls-remote can read is a repo", async () => {
  const gitLsRemote: GitLsRemoteFn = vi.fn(async () => true);
  const fetchHead: FetchHeadFn = vi.fn();
  expect(await sniffUrl("https://github.com/etcd-io/etcd", gitLsRemote, fetchHead)).toBe("repo");
  expect(fetchHead).not.toHaveBeenCalled();
});

test("a URL that fails ls-remote but returns HTML is a page", async () => {
  const gitLsRemote: GitLsRemoteFn = async () => false;
  const fetchHead: FetchHeadFn = async () => ({ ok: true, contentType: "text/html; charset=utf-8" });
  expect(await sniffUrl("https://newsletter.pragmaticengineer.com/p/ai-tooling", gitLsRemote, fetchHead)).toBe("page");
});

test("a URL that fails both checks is unknown", async () => {
  const gitLsRemote: GitLsRemoteFn = async () => false;
  const fetchHead: FetchHeadFn = async () => ({ ok: false, contentType: null });
  expect(await sniffUrl("https://unreachable.example", gitLsRemote, fetchHead)).toBe("unknown");
});

test("a thrown git probe error falls through to the page check", async () => {
  const gitLsRemote: GitLsRemoteFn = async () => { throw new Error("git ENOENT"); };
  const fetchHead: FetchHeadFn = async () => ({ ok: true, contentType: "text/html" });
  expect(await sniffUrl("https://example.com", gitLsRemote, fetchHead)).toBe("page");
});

test("a thrown fetch error resolves to unknown", async () => {
  const gitLsRemote: GitLsRemoteFn = async () => false;
  const fetchHead: FetchHeadFn = async () => { throw new Error("network down"); };
  expect(await sniffUrl("https://example.com", gitLsRemote, fetchHead)).toBe("unknown");
});

test("a non-HTML content type is not treated as a page", async () => {
  const gitLsRemote: GitLsRemoteFn = async () => false;
  const fetchHead: FetchHeadFn = async () => ({ ok: true, contentType: "application/pdf" });
  expect(await sniffUrl("https://example.com/file.pdf", gitLsRemote, fetchHead)).toBe("unknown");
});

test("an unsafe URL is unknown without touching git or fetch", async () => {
  const gitLsRemote = vi.fn<GitLsRemoteFn>();
  const fetchHead = vi.fn<FetchHeadFn>();
  expect(await sniffUrl("file:///etc/hosts", gitLsRemote, fetchHead)).toBe("unknown");
  expect(await sniffUrl("http://127.0.0.1:3000/", gitLsRemote, fetchHead)).toBe("unknown");
  expect(gitLsRemote).not.toHaveBeenCalled();
  expect(fetchHead).not.toHaveBeenCalled();
});

test("isSafeRemoteUrl rejects non-http(s) schemes and loopback/private/link-local hosts", () => {
  for (const bad of [
    "file:///etc/hosts",
    "ssh://git@github.com/x/y",
    "ftp://example.com",
    "not a url",
    "http://localhost/",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
  ]) {
    expect(isSafeRemoteUrl(bad), bad).toBe(false);
  }
  for (const ok of [
    "https://github.com/etcd-io/etcd",
    "http://example.com/page",
    "https://172.32.0.1/",
    "https://8.8.8.8/",
  ]) {
    expect(isSafeRemoteUrl(ok), ok).toBe(true);
  }
});
