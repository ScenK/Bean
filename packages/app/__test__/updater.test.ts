import { describe, expect, test, vi } from "vitest";
import { fetchLatestRelease, downloadAsset, extractAndSign, currentAppBundlePath } from "../src/updater.js";

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
