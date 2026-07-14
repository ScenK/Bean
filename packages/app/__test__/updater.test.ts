import { describe, expect, test, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { fetchLatestRelease, downloadAsset, extractAndSign, currentAppBundlePath, installAndRelaunch, checkAndDownloadUpdate } from "../src/updater.js";

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
    expect(h.removed).toEqual(["/Applications/Bean.app.old", "/tmp/bean-update-xyz"]);
    expect(h.copied).toEqual([]);
    expect(h.relaunched()).toBe(true);
    expect(h.exited()).toBe(true);
  });

  test("removes the whole temp parent directory (not just the backup) after a direct-rename swap", async () => {
    const h = harness();
    await installAndRelaunch("/tmp/bean-update-xyz/Bean.app", h.deps);
    expect(h.removed).toContain("/tmp/bean-update-xyz");
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
    expect(h.removed).toEqual(["/Applications/Bean.app.old", "/tmp/bean-update-xyz"]);
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
    expect(h.removed).toEqual([]);
    expect(h.relaunched()).toBe(false);
    expect(h.exited()).toBe(false);
  });

  test("cleans up a partial copy before rolling back when the recursive copy itself fails (EXDEV)", async () => {
    const sequence: string[] = [];
    let relaunched = false;
    let exited = false;
    const deps = {
      currentAppPath: "/Applications/Bean.app",
      rename: vi.fn(async (from: string, to: string) => {
        if (from === "/tmp/bean-update-xyz/Bean.app") {
          const err = new Error("cross-device") as NodeJS.ErrnoException;
          err.code = "EXDEV";
          throw err;
        }
        sequence.push(`rename:${from}->${to}`);
      }),
      copyRecursive: vi.fn(async () => { throw new Error("copy failed"); }),
      rm: vi.fn(async (p: string) => { sequence.push(`rm:${p}`); }),
      relaunch: () => { relaunched = true; },
      exit: () => { exited = true; },
    };

    await expect(installAndRelaunch("/tmp/bean-update-xyz/Bean.app", deps)).rejects.toThrow("copy failed");

    // The copy error must be rethrown as-is (not masked), and currentAppPath must be
    // cleared BEFORE the rollback rename, so the rollback can't collide with a partial copy.
    expect(sequence).toEqual([
      "rename:/Applications/Bean.app->/Applications/Bean.app.old",
      "rm:/Applications/Bean.app",
      "rename:/Applications/Bean.app.old->/Applications/Bean.app",
    ]);
    expect(relaunched).toBe(false);
    expect(exited).toBe(false);
  });

  test("does not roll back a successful EXDEV copy even if temp-dir cleanup fails", async () => {
    const h = harness();
    h.deps.rename = vi.fn(async (from: string, to: string) => {
      if (from === "/tmp/bean-update-xyz/Bean.app") {
        const err = new Error("cross-device") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      h.renamed.push([from, to]);
    });
    h.deps.rm = vi.fn(async (p: string) => {
      if (p === "/tmp/bean-update-xyz") throw new Error("cleanup failed");
      h.removed.push(p);
    });

    await expect(installAndRelaunch("/tmp/bean-update-xyz/Bean.app", h.deps)).resolves.toBeUndefined();

    expect(h.copied).toEqual([["/tmp/bean-update-xyz/Bean.app", "/Applications/Bean.app"]]);
    expect(h.renamed).toEqual([
      ["/Applications/Bean.app", "/Applications/Bean.app.old"],
    ]);
    expect(h.removed).toEqual(["/Applications/Bean.app.old"]);
    expect(h.relaunched()).toBe(true);
    expect(h.exited()).toBe(true);
  });
});

describe("checkAndDownloadUpdate", () => {
  function keypair() {
    return generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  }

  test("returns up-to-date without downloading anything when no newer release exists", async () => {
    const download = vi.fn();
    const outcome = await checkAndDownloadUpdate("9.9.9", {
      fetchRelease: async () => ({ tagName: "v0.1.0", body: "", assets: [] }),
      downloadAsset: download,
    });
    expect(outcome).toEqual({ result: { status: "up-to-date" } });
    expect(download).not.toHaveBeenCalled();
  });

  test("downloads, verifies, and extracts when a correctly signed newer release exists", async () => {
    const { publicKey, privateKey } = keypair();
    const zipBytes = Buffer.from("zip-bytes");
    const signature = cryptoSign(null, zipBytes, privateKey).toString("base64");
    const extract = vi.fn(async () => "/tmp/bean-update-xyz/Bean.app");

    const outcome = await checkAndDownloadUpdate("0.8.12", {
      fetchRelease: async () => ({
        tagName: "v0.8.13",
        body: "notes",
        assets: [
          { name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://x/zip" },
          { name: "Bean-0.8.13-arm64-mac.zip.sig", browserDownloadUrl: "https://x/sig" },
        ],
      }),
      downloadAsset: async (url) => (url === "https://x/zip" ? zipBytes : Buffer.from(signature, "utf8")),
      extract,
      publicKeyPem: publicKey,
    });

    expect(outcome.result).toEqual({
      status: "available", version: "0.8.13", notes: "notes",
      zipUrl: "https://x/zip", sigUrl: "https://x/sig",
    });
    expect(outcome.extractedAppPath).toBe("/tmp/bean-update-xyz/Bean.app");
    expect(extract).toHaveBeenCalledWith(zipBytes);
  });

  test("errors without extracting when the signature doesn't match", async () => {
    const { privateKey } = keypair();
    const { publicKey: unrelatedPublicKey } = keypair();
    const zipBytes = Buffer.from("zip-bytes");
    const signature = cryptoSign(null, zipBytes, privateKey).toString("base64");
    const extract = vi.fn();

    const outcome = await checkAndDownloadUpdate("0.8.12", {
      fetchRelease: async () => ({
        tagName: "v0.8.13",
        body: "notes",
        assets: [
          { name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://x/zip" },
          { name: "Bean-0.8.13-arm64-mac.zip.sig", browserDownloadUrl: "https://x/sig" },
        ],
      }),
      downloadAsset: async (url) => (url === "https://x/zip" ? zipBytes : Buffer.from(signature, "utf8")),
      extract,
      publicKeyPem: unrelatedPublicKey,
    });

    expect(outcome.result).toEqual({
      status: "error",
      message: "Update signature verification failed — this release may be corrupted or tampered with.",
    });
    expect(extract).not.toHaveBeenCalled();
  });

  test("surfaces a network error from fetchRelease without throwing", async () => {
    const outcome = await checkAndDownloadUpdate("0.8.12", {
      fetchRelease: async () => { throw new Error("ENOTFOUND"); },
    });
    expect(outcome).toEqual({ result: { status: "error", message: "Couldn't reach GitHub: ENOTFOUND" } });
  });

  test("surfaces a download error without throwing", async () => {
    const outcome = await checkAndDownloadUpdate("0.8.12", {
      fetchRelease: async () => ({
        tagName: "v0.8.13",
        body: "",
        assets: [
          { name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://x/zip" },
          { name: "Bean-0.8.13-arm64-mac.zip.sig", browserDownloadUrl: "https://x/sig" },
        ],
      }),
      downloadAsset: async () => { throw new Error("ECONNRESET"); },
    });
    expect(outcome).toEqual({ result: { status: "error", message: "Download failed: ECONNRESET" } });
  });
});
