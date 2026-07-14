import { describe, expect, test, vi } from "vitest";
import { fetchLatestRelease, downloadAsset, extractAndSign, currentAppBundlePath, installAndRelaunch } from "../src/updater.js";

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer : new TextEncoder().encode(String(body)).buffer),
  } as Response;
}

describe("fetchLatestRelease", () => {
  test("maps the GitHub API response to camelCase asset fields", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({
      tag_name: "v0.8.13",
      body: "notes",
      assets: [{ name: "Bean-0.8.13-arm64-mac.zip", browser_download_url: "https://x/zip" }],
    }));
    const release = await fetchLatestRelease(fetchImpl as unknown as typeof fetch);
    expect(release).toEqual({
      tagName: "v0.8.13",
      body: "notes",
      assets: [{ name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://x/zip" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/ScenK/Bean/releases/latest");
  });

  test("throws when the GitHub API responds with a non-OK status", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({}, false, 503));
    await expect(fetchLatestRelease(fetchImpl as unknown as typeof fetch)).rejects.toThrow("GitHub API returned 503");
  });
});

describe("downloadAsset", () => {
  test("returns the response body as a Buffer", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(new TextEncoder().encode("zip-bytes")));
    const buf = await downloadAsset("https://x/zip", fetchImpl as unknown as typeof fetch);
    expect(buf.toString("utf8")).toBe("zip-bytes");
  });

  test("throws when the download responds with a non-OK status", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({}, false, 404));
    await expect(downloadAsset("https://x/zip", fetchImpl as unknown as typeof fetch)).rejects.toThrow("Download failed (404)");
  });
});

describe("extractAndSign", () => {
  test("writes the zip, ditto-extracts it, ad-hoc codesigns it, and returns the Bean.app path", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const written: { path: string; data: Buffer }[] = [];
    const appPath = await extractAndSign(Buffer.from("zip-bytes"), {
      mkdtemp: async () => "/tmp/bean-update-xyz",
      writeFile: async (path, data) => { written.push({ path, data }); },
      runCodesignAndDitto: async (cmd, args) => { calls.push({ cmd, args }); },
    });
    expect(appPath).toBe("/tmp/bean-update-xyz/Bean.app");
    expect(written).toEqual([{ path: "/tmp/bean-update-xyz/Bean-update.zip", data: Buffer.from("zip-bytes") }]);
    expect(calls).toEqual([
      { cmd: "ditto", args: ["-x", "-k", "/tmp/bean-update-xyz/Bean-update.zip", "/tmp/bean-update-xyz"] },
      { cmd: "codesign", args: ["--force", "--deep", "--sign", "-", "/tmp/bean-update-xyz/Bean.app"] },
    ]);
  });
});

describe("currentAppBundlePath", () => {
  test("walks up from the executable path to the .app bundle root", () => {
    expect(currentAppBundlePath("/Applications/Bean.app/Contents/MacOS/Bean")).toBe("/Applications/Bean.app");
  });
});

describe("installAndRelaunch", () => {
  function harness() {
    const renamed: [string, string][] = [];
    const copied: [string, string][] = [];
    const removed: string[] = [];
    let relaunched = false;
    let exited = false;
    const deps = {
      currentAppPath: "/Applications/Bean.app",
      rename: vi.fn(async (from: string, to: string) => { renamed.push([from, to]); }),
      copyRecursive: vi.fn(async (from: string, to: string) => { copied.push([from, to]); }),
      rm: vi.fn(async (p: string) => { removed.push(p); }),
      relaunch: () => { relaunched = true; },
      exit: () => { exited = true; },
    };
    return { deps, renamed, copied, removed, relaunched: () => relaunched, exited: () => exited };
  }

  test("renames the current bundle aside, the new one into place, cleans up, then relaunches", async () => {
    const h = harness();
    await installAndRelaunch("/tmp/bean-update-xyz/Bean.app", h.deps);
    expect(h.renamed).toEqual([
      ["/Applications/Bean.app", "/Applications/Bean.app.old"],
      ["/tmp/bean-update-xyz/Bean.app", "/Applications/Bean.app"],
    ]);
    expect(h.removed).toEqual(["/Applications/Bean.app.old"]);
    expect(h.copied).toEqual([]);
    expect(h.relaunched()).toBe(true);
    expect(h.exited()).toBe(true);
  });

  test("falls back to a recursive copy on a cross-device rename (EXDEV)", async () => {
    const h = harness();
    h.deps.rename = vi.fn(async (from: string, to: string) => {
      if (from === "/tmp/bean-update-xyz/Bean.app") {
        const err = new Error("cross-device") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      h.renamed.push([from, to]);
    });
    await installAndRelaunch("/tmp/bean-update-xyz/Bean.app", h.deps);
    expect(h.copied).toEqual([["/tmp/bean-update-xyz/Bean.app", "/Applications/Bean.app"]]);
    expect(h.removed).toEqual(["/tmp/bean-update-xyz/Bean.app", "/Applications/Bean.app.old"]);
    expect(h.relaunched()).toBe(true);
  });

  test("rolls back and rethrows when swapping the new bundle into place fails", async () => {
    const h = harness();
    h.deps.rename = vi.fn(async (from: string, to: string) => {
      if (from === "/tmp/bean-update-xyz/Bean.app") throw new Error("disk full");
      h.renamed.push([from, to]);
    });
    await expect(installAndRelaunch("/tmp/bean-update-xyz/Bean.app", h.deps)).rejects.toThrow("disk full");
    expect(h.renamed).toEqual([
      ["/Applications/Bean.app", "/Applications/Bean.app.old"],
      ["/Applications/Bean.app.old", "/Applications/Bean.app"],
    ]);
    expect(h.relaunched()).toBe(false);
    expect(h.exited()).toBe(false);
  });
});
