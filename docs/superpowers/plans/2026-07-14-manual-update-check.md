# Manual Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Check for Updates" flow to Bean's About panel: click → check GitHub Releases → download + Ed25519-verify → confirm → swap the running `.app` bundle in place → relaunch.

**Architecture:** Pure decision/crypto logic (`compareVersions`, `checkForUpdate`, `verifyUpdateSignature`) lives in `@bean/core`, dependency-injected and Electron-free. All IO (GitHub fetch, download, `ditto`/`codesign` extraction, the bundle-swap rename-dance, relaunch) lives in `@bean/app`'s new `updater.ts`, wired through two IPC calls (`bean:check-for-update`, `bean:install-update`) into a stateful About-panel UI. A CI step signs each release's zip with an Ed25519 private key (GitHub secret); the app verifies that signature against a committed public key before ever extracting/installing anything.

**Tech Stack:** TypeScript, Node's built-in `crypto`/`fetch`/`child_process`, Vitest, Preact (About panel), Electron (`app.relaunch`/`app.exit`/`shell.openExternal`), electron-builder + GitHub Actions (existing `mac-installer.yml`).

## Global Constraints

- Both packages are ESM with `verbatimModuleSyntax` — relative imports use `.js` extensions, type-only imports use `import type`.
- `strict` + `noUncheckedIndexedAccess` are on — array/object index access is `T | undefined`; handle it (e.g. `pa[i] ?? 0`).
- `@bean/core` stays pure and dependency-injected — zero Electron imports (`.memory/convention-core-is-electron-free.md`). Every IO-touching function takes injectable deps with real defaults, matching `packages/core/src/launcher.ts`'s style.
- New IPC channels are defined once in `packages/app/src/channels.ts` (`convention-ipc-channels.md`) — never string-literal a channel name elsewhere.
- The ad-hoc codesign command is exactly `codesign --force --deep --sign - <appPath>` (matches `packages/app/scripts/after-sign.mjs`) — this satisfies macOS's "must be signed to execute" bar only, and is unrelated to the Ed25519 authenticity check.
- Never commit the Ed25519 **private** key anywhere. The committed public key (`packages/core/src/update-public-key.ts`) is a development placeholder until the maintainer replaces it (Task 12) — do not treat it as production-ready.
- Run `pnpm test && pnpm typecheck` from the repo root before considering any task's commit final, per `AGENTS.md`'s validation gate.
- Full spec: `docs/superpowers/specs/2026-07-14-manual-update-check-design.md` — every task below implements a section of it; consult it for the "why" behind a design choice.

---

### Task 1: Core — version comparison + update availability decision

**Files:**
- Create: `packages/core/src/updater.ts`
- Create: `packages/core/__test__/updater.test.ts`
- Modify: `packages/core/src/index.ts` (add barrel export)

**Interfaces:**
- Produces: `compareVersions(a: string, b: string): number`, `checkForUpdate(currentVersion: string, release: GithubReleaseInfo): UpdateCheckResult`, and the types `GithubReleaseAsset { name: string; browserDownloadUrl: string }`, `GithubReleaseInfo { tagName: string; body: string; assets: GithubReleaseAsset[] }`, `UpdateCheckResult = { status: "up-to-date" } | { status: "available"; version: string; notes: string; zipUrl: string; sigUrl: string } | { status: "error"; message: string }`. Later tasks (3, 5, 6) import all of these from `@bean/core`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__test__/updater.test.ts`:

```typescript
import { expect, test } from "vitest";
import { compareVersions, checkForUpdate } from "../src/updater.js";
import type { GithubReleaseInfo } from "../src/updater.js";

test("compareVersions orders by major, then minor, then patch", () => {
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
  expect(compareVersions("1.1.9", "1.2.0")).toBeLessThan(0);
  expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
});

test("compareVersions strips a leading v", () => {
  expect(compareVersions("v0.8.13", "0.8.12")).toBeGreaterThan(0);
  expect(compareVersions("0.8.12", "v0.8.12")).toBe(0);
});

function release(overrides: Partial<GithubReleaseInfo> = {}): GithubReleaseInfo {
  return {
    tagName: "v0.8.13",
    body: "## What's Changed\n* fix: something",
    assets: [
      { name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://example.com/zip" },
      { name: "Bean-0.8.13-arm64-mac.zip.sig", browserDownloadUrl: "https://example.com/sig" },
      { name: "Bean-0.8.13-arm64.dmg", browserDownloadUrl: "https://example.com/dmg" },
    ],
    ...overrides,
  };
}

test("checkForUpdate reports up-to-date when the release isn't newer", () => {
  expect(checkForUpdate("0.8.13", release())).toEqual({ status: "up-to-date" });
  expect(checkForUpdate("0.8.14", release())).toEqual({ status: "up-to-date" });
});

test("checkForUpdate reports the zip+sig asset URLs when a newer release exists", () => {
  expect(checkForUpdate("0.8.12", release())).toEqual({
    status: "available",
    version: "0.8.13",
    notes: "## What's Changed\n* fix: something",
    zipUrl: "https://example.com/zip",
    sigUrl: "https://example.com/sig",
  });
});

test("checkForUpdate errors when the release has no arm64 mac zip asset", () => {
  const r = release({ assets: [{ name: "Bean-0.8.13-arm64.dmg", browserDownloadUrl: "https://example.com/dmg" }] });
  expect(checkForUpdate("0.8.12", r)).toEqual({
    status: "error",
    message: "Release v0.8.13 has no arm64 mac zip asset.",
  });
});

test("checkForUpdate errors when the zip has no matching .sig asset", () => {
  const r = release({ assets: [{ name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://example.com/zip" }] });
  expect(checkForUpdate("0.8.12", r)).toEqual({
    status: "error",
    message: "Release v0.8.13 is missing its update signature.",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/updater.test.ts`
Expected: FAIL — `Cannot find module '../src/updater.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/updater.ts`:

```typescript
export interface GithubReleaseAsset {
  name: string;
  browserDownloadUrl: string;
}

export interface GithubReleaseInfo {
  tagName: string;
  body: string;
  assets: GithubReleaseAsset[];
}

export type UpdateCheckResult =
  | { status: "up-to-date" }
  | { status: "available"; version: string; notes: string; zipUrl: string; sigUrl: string }
  | { status: "error"; message: string };

/** Compares two "vX.Y.Z"/"X.Y.Z" version strings. Positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const partsOf = (v: string): number[] => v.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const pa = partsOf(a);
  const pb = partsOf(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Decides whether `release` is newer than `currentVersion` and picks the arm64 mac zip +
 * its signature sidecar. Pure — takes an already-fetched release payload, no network IO. */
export function checkForUpdate(currentVersion: string, release: GithubReleaseInfo): UpdateCheckResult {
  const latestVersion = release.tagName.replace(/^v/, "");
  if (compareVersions(latestVersion, currentVersion) <= 0) return { status: "up-to-date" };

  const zipAsset = release.assets.find((a) => a.name.endsWith("-arm64-mac.zip"));
  if (!zipAsset) return { status: "error", message: `Release ${release.tagName} has no arm64 mac zip asset.` };

  const sigAsset = release.assets.find((a) => a.name === `${zipAsset.name}.sig`);
  if (!sigAsset) return { status: "error", message: `Release ${release.tagName} is missing its update signature.` };

  return {
    status: "available",
    version: latestVersion,
    notes: release.body,
    zipUrl: zipAsset.browserDownloadUrl,
    sigUrl: sigAsset.browserDownloadUrl,
  };
}
```

Add to `packages/core/src/index.ts` (after the last `export *` line, before the named `cron`/`routine-store` exports — anywhere in the file is fine since these are all just re-exports):

```typescript
export * from "./updater.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/updater.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/updater.ts packages/core/__test__/updater.test.ts packages/core/src/index.ts
git commit -m "feat(core): add version compare and update-availability decision logic"
```

---

### Task 2: Core — Ed25519 signature verification + committed public key

**Files:**
- Modify: `packages/core/src/updater.ts` (add `verifyUpdateSignature`)
- Modify: `packages/core/__test__/updater.test.ts` (append tests)
- Create: `packages/core/src/update-public-key.ts`
- Modify: `packages/core/src/index.ts` (add barrel export)

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent function in the same file).
- Produces: `verifyUpdateSignature(data: Buffer, signatureBase64: string, publicKeyPem: string): boolean` and `UPDATE_PUBLIC_KEY_PEM: string`. Task 5 (`checkAndDownloadUpdate`) imports both from `@bean/core`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__test__/updater.test.ts` (add to the existing imports and add these tests at the end of the file):

```typescript
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyUpdateSignature } from "../src/updater.js";

function testKeypair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("verifyUpdateSignature accepts a signature made with the matching private key", () => {
  const { publicKey, privateKey } = testKeypair();
  const data = Buffer.from("Bean update payload");
  const signature = cryptoSign(null, data, privateKey).toString("base64");
  expect(verifyUpdateSignature(data, signature, publicKey)).toBe(true);
});

test("verifyUpdateSignature rejects a signature made with a different private key", () => {
  const { publicKey } = testKeypair();
  const { privateKey: otherPrivateKey } = testKeypair();
  const data = Buffer.from("Bean update payload");
  const signature = cryptoSign(null, data, otherPrivateKey).toString("base64");
  expect(verifyUpdateSignature(data, signature, publicKey)).toBe(false);
});

test("verifyUpdateSignature rejects tampered data", () => {
  const { publicKey, privateKey } = testKeypair();
  const signature = cryptoSign(null, Buffer.from("original"), privateKey).toString("base64");
  expect(verifyUpdateSignature(Buffer.from("tampered"), signature, publicKey)).toBe(false);
});

test("verifyUpdateSignature returns false instead of throwing on a malformed public key", () => {
  expect(verifyUpdateSignature(Buffer.from("x"), "not-base64!!", "not a pem key")).toBe(false);
});
```

(Note: move the `import { expect, test } from "vitest"` and other existing imports at the top of the file as needed — just add the two new imports above alongside them; don't duplicate the `vitest` import.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/updater.test.ts`
Expected: FAIL — `verifyUpdateSignature is not exported` / `Cannot find module`.

- [ ] **Step 3: Write the implementation**

Add to the top of `packages/core/src/updater.ts` (new import) and append at the end of the file:

```typescript
import { createPublicKey, verify } from "node:crypto";
```

```typescript
/** Verifies an update's Ed25519 signature against the committed public key. Never throws —
 * a malformed key/signature/data combination is just an invalid signature. */
export function verifyUpdateSignature(data: Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureBase64, "base64");
    return verify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}
```

Create `packages/core/src/update-public-key.ts`:

```typescript
// Ed25519 public key used to verify Bean update releases before installing them (see
// docs/superpowers/specs/2026-07-14-manual-update-check-design.md). Public keys are not
// secret — they ship inside the app so it can verify signatures the private key produced.
//
// PLACEHOLDER: this is a throwaway keypair generated during development. Replace it with a
// real, maintainer-generated public key before cutting the first real signed release — see
// .memory/project-manual-update-check.md for the one-time setup steps. The matching private
// key for THIS placeholder was never stored anywhere and cannot sign real releases.
export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEACk091RlITM4UfITjtCeJS2Q7qzTNFbN6ts0ePlk3Nkk=
-----END PUBLIC KEY-----
`;
```

Add to `packages/core/src/index.ts`:

```typescript
export * from "./update-public-key.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/updater.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/updater.ts packages/core/__test__/updater.test.ts packages/core/src/update-public-key.ts packages/core/src/index.ts
git commit -m "feat(core): add Ed25519 update-signature verification and placeholder public key"
```

---

### Task 3: App — fetch release info, download an asset, extract + ad-hoc sign

**Files:**
- Create: `packages/app/src/updater.ts`
- Create: `packages/app/__test__/updater.test.ts`

**Interfaces:**
- Consumes: `GithubReleaseInfo` type from `@bean/core` (Task 1).
- Produces: `fetchLatestRelease(fetchImpl?: typeof fetch): Promise<GithubReleaseInfo>`, `downloadAsset(url: string, fetchImpl?: typeof fetch): Promise<Buffer>`, `extractAndSign(zipBuffer: Buffer, deps?: ExtractDeps): Promise<string>`, `currentAppBundlePath(execPath?: string): string`. Tasks 4 and 5 build on these; Task 6 (main.ts) wires the real `fetch`-backed defaults.

- [ ] **Step 1: Write the failing tests**

Create `packages/app/__test__/updater.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/updater.test.ts`
Expected: FAIL — `Cannot find module '../src/updater.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/app/src/updater.ts`:

```typescript
import { app } from "electron";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp as mkdtempCb, writeFile as writeFileCb } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GithubReleaseInfo } from "@bean/core";

const execFile = promisify(execFileCb);
const REPO = "ScenK/Bean";

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<GithubReleaseInfo> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const json = await res.json() as {
    tag_name: string;
    body: string;
    assets: { name: string; browser_download_url: string }[];
  };
  return {
    tagName: json.tag_name,
    body: json.body,
    assets: json.assets.map((a) => ({ name: a.name, browserDownloadUrl: a.browser_download_url })),
  };
}

export async function downloadAsset(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface ExtractDeps {
  mkdtemp?: () => Promise<string>;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  runCodesignAndDitto?: (cmd: string, args: string[]) => Promise<void>;
}

/** Extracts a downloaded update zip and ad-hoc re-signs the bundle (same command as
 * scripts/after-sign.mjs uses at build time) so macOS will execute it. Returns the path to
 * the extracted, signed Bean.app inside a fresh temp directory. */
export async function extractAndSign(zipBuffer: Buffer, deps: ExtractDeps = {}): Promise<string> {
  const mkdtemp = deps.mkdtemp ?? (() => mkdtempCb(join(tmpdir(), "bean-update-")));
  const writeFile = deps.writeFile ?? ((p, d) => writeFileCb(p, d));
  const run = deps.runCodesignAndDitto ?? (async (cmd, args) => { await execFile(cmd, args); });

  const dir = await mkdtemp();
  const zipPath = join(dir, "Bean-update.zip");
  await writeFile(zipPath, zipBuffer);
  await run("ditto", ["-x", "-k", zipPath, dir]);
  const appPath = join(dir, "Bean.app");
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  return appPath;
}

/** Walks up from the running Electron binary's path to its enclosing .app bundle root
 * (".../Bean.app/Contents/MacOS/Bean" -> ".../Bean.app"). */
export function currentAppBundlePath(execPath: string = app.getPath("exe")): string {
  return dirname(dirname(dirname(execPath)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/updater.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/updater.ts packages/app/__test__/updater.test.ts
git commit -m "feat(app): fetch/download release assets and extract+ad-hoc-sign the update bundle"
```

---

### Task 4: App — install (swap bundle) and relaunch

**Files:**
- Modify: `packages/app/src/updater.ts` (add `installAndRelaunch`)
- Modify: `packages/app/__test__/updater.test.ts` (append tests)

**Interfaces:**
- Consumes: `currentAppBundlePath` (Task 3, same file) as the default for `deps.currentAppPath`.
- Produces: `installAndRelaunch(extractedAppPath: string, deps?: InstallDeps): Promise<void>`. Task 5 leaves this untouched (a separate confirmed step); Task 6 wires the real Electron-backed defaults into the IPC handler.

- [ ] **Step 1: Write the failing tests**

Append to `packages/app/__test__/updater.test.ts` (add `installAndRelaunch` to the existing import line, and add this `describe` block at the end of the file):

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/updater.test.ts`
Expected: FAIL — `installAndRelaunch is not exported` / `Cannot find module`.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `packages/app/src/updater.ts` (extend the existing `node:fs/promises` import and add one more):

```typescript
import { mkdtemp as mkdtempCb, writeFile as writeFileCb, rename as renameCb, rm as rmCb, cp as cpCb } from "node:fs/promises";
```

Append to `packages/app/src/updater.ts`:

```typescript
export interface InstallDeps {
  currentAppPath?: string;
  rename?: (from: string, to: string) => Promise<void>;
  copyRecursive?: (from: string, to: string) => Promise<void>;
  rm?: (path: string) => Promise<void>;
  relaunch?: () => void;
  exit?: () => void;
}

/** Swaps the extracted update bundle into the currently-running app's path — the same
 * rename-dance Sparkle/Squirrel use — then relaunches. Rolls back if the swap itself fails,
 * so the install path is never left without an app bundle. */
export async function installAndRelaunch(extractedAppPath: string, deps: InstallDeps = {}): Promise<void> {
  const currentAppPath = deps.currentAppPath ?? currentAppBundlePath();
  const rename = deps.rename ?? ((from, to) => renameCb(from, to));
  const copyRecursive = deps.copyRecursive ?? ((from, to) => cpCb(from, to, { recursive: true }));
  const rm = deps.rm ?? ((p) => rmCb(p, { recursive: true, force: true }));
  const relaunch = deps.relaunch ?? (() => app.relaunch());
  const exit = deps.exit ?? (() => app.exit());

  const backupPath = `${currentAppPath}.old`;
  await rename(currentAppPath, backupPath);

  try {
    try {
      await rename(extractedAppPath, currentAppPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        await copyRecursive(extractedAppPath, currentAppPath);
        await rm(extractedAppPath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    await rename(backupPath, currentAppPath);
    throw err;
  }

  await rm(backupPath).catch(() => {});
  relaunch();
  exit();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/updater.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/updater.ts packages/app/__test__/updater.test.ts
git commit -m "feat(app): swap the update bundle into place and relaunch, with EXDEV fallback and rollback"
```

---

### Task 5: App — compose the full check-and-download pipeline

**Files:**
- Modify: `packages/app/src/updater.ts` (add `checkAndDownloadUpdate`)
- Modify: `packages/app/__test__/updater.test.ts` (append tests)

**Interfaces:**
- Consumes: `checkForUpdate`, `verifyUpdateSignature`, `UPDATE_PUBLIC_KEY_PEM` from `@bean/core` (Tasks 1–2); `fetchLatestRelease`, `downloadAsset`, `extractAndSign` from the same file (Task 3).
- Produces: `checkAndDownloadUpdate(currentVersion: string, deps?: CheckAndDownloadDeps): Promise<UpdateCheckOutcome>` where `UpdateCheckOutcome = { result: UpdateCheckResult; extractedAppPath?: string }`. Task 6's IPC handler calls this directly.

- [ ] **Step 1: Write the failing tests**

Append to `packages/app/__test__/updater.test.ts` (add `checkAndDownloadUpdate` to the import, and add `import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";` near the top):

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/updater.test.ts`
Expected: FAIL — `checkAndDownloadUpdate is not exported` / `Cannot find module`.

- [ ] **Step 3: Write the implementation**

Update the `@bean/core` import at the top of `packages/app/src/updater.ts`:

```typescript
import {
  checkForUpdate, verifyUpdateSignature, UPDATE_PUBLIC_KEY_PEM,
  type GithubReleaseInfo, type UpdateCheckResult,
} from "@bean/core";
```

Append to `packages/app/src/updater.ts`:

```typescript
export interface UpdateCheckOutcome {
  result: UpdateCheckResult;
  extractedAppPath?: string;
}

export interface CheckAndDownloadDeps {
  fetchRelease?: () => Promise<GithubReleaseInfo>;
  downloadAsset?: (url: string) => Promise<Buffer>;
  extract?: (zipBuffer: Buffer) => Promise<string>;
  publicKeyPem?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Composes the full manual-update pipeline: fetch the latest release, decide if it's newer,
 * download + verify the zip's signature, and extract+sign it — everything up to (not
 * including) the actual install swap, which is a separate explicit user confirmation. */
export async function checkAndDownloadUpdate(currentVersion: string, deps: CheckAndDownloadDeps = {}): Promise<UpdateCheckOutcome> {
  const fetchRelease = deps.fetchRelease ?? fetchLatestRelease;
  const download = deps.downloadAsset ?? downloadAsset;
  const extract = deps.extract ?? extractAndSign;
  const publicKeyPem = deps.publicKeyPem ?? UPDATE_PUBLIC_KEY_PEM;

  let release: GithubReleaseInfo;
  try {
    release = await fetchRelease();
  } catch (err) {
    return { result: { status: "error", message: `Couldn't reach GitHub: ${errorMessage(err)}` } };
  }

  const check = checkForUpdate(currentVersion, release);
  if (check.status !== "available") return { result: check };

  let zipBuffer: Buffer;
  let sigBuffer: Buffer;
  try {
    [zipBuffer, sigBuffer] = await Promise.all([download(check.zipUrl), download(check.sigUrl)]);
  } catch (err) {
    return { result: { status: "error", message: `Download failed: ${errorMessage(err)}` } };
  }

  const signatureBase64 = sigBuffer.toString("utf8").trim();
  if (!verifyUpdateSignature(zipBuffer, signatureBase64, publicKeyPem)) {
    return { result: { status: "error", message: "Update signature verification failed — this release may be corrupted or tampered with." } };
  }

  let extractedAppPath: string;
  try {
    extractedAppPath = await extract(zipBuffer);
  } catch (err) {
    return { result: { status: "error", message: `Couldn't prepare the update: ${errorMessage(err)}` } };
  }

  return { result: check, extractedAppPath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/updater.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/updater.ts packages/app/__test__/updater.test.ts
git commit -m "feat(app): compose fetch+download+verify+extract into checkAndDownloadUpdate"
```

---

### Task 6: App — IPC channels and handlers

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/__test__/ipc.test.ts` (check existing structure first, then append)

**Interfaces:**
- Consumes: `UpdateCheckOutcome` type and `checkAndDownloadUpdate`/`installAndRelaunch` function shapes from `packages/app/src/updater.ts` (Tasks 3–5).
- Produces: `IPC.checkForUpdate`, `IPC.installUpdate`, `IPC.openUpdateReleasePage` channel names; `UpdateStatus`, `InstallUpdateResult` types (renderer-facing, JSON-safe — no file paths or asset URLs); `buildPendingUpdateStore()`; `buildUpdateHandlers(deps: UpdateHandlerDeps)`; `RegisterDeps` extended with `UpdateHandlerDeps`. Tasks 7 (preload/bean.d.ts) and 8 (main.ts) consume all of these.

- [ ] **Step 1: Write the failing tests**

`packages/app/__test__/ipc.test.ts` uses plain `test()` (not `describe`/`it`) and imports handler builders directly from `"../src/ipc.js"` — match that. Add `buildPendingUpdateStore, buildUpdateHandlers` to the existing import from `"../src/ipc.js"` (the multi-line import at the top of the file), and append these tests at the end of the file:

```typescript
test("buildPendingUpdateStore returns undefined until set, then the same value on repeated get (not consumed)", () => {
  const store = buildPendingUpdateStore();
  expect(store.get()).toBeUndefined();
  store.set("/tmp/bean-update-xyz/Bean.app");
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
});

test("buildUpdateHandlers.check strips extractedAppPath/URLs before returning to the renderer, and stores the path for install", async () => {
  const store = buildPendingUpdateStore();
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    checkAndDownloadUpdate: async () => ({
      result: { status: "available", version: "0.8.13", notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
      extractedAppPath: "/tmp/bean-update-xyz/Bean.app",
    }),
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
  });
  const status = await handlers.check();
  expect(status).toEqual({ status: "available", version: "0.8.13", notes: "notes" });
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
});

test("buildUpdateHandlers.check passes up-to-date/error results through unchanged", async () => {
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
  });
  expect(await handlers.check()).toEqual({ status: "up-to-date" });
});

test("buildUpdateHandlers.install errors when nothing has been checked/downloaded yet", async () => {
  const installed: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
  });
  expect(await handlers.install()).toEqual({
    status: "error",
    message: "No update is ready to install — check for updates again.",
  });
  expect(installed).toEqual([]);
});

test("buildUpdateHandlers.install calls installUpdate with the stored path", async () => {
  const installed: string[] = [];
  const store = buildPendingUpdateStore();
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    checkAndDownloadUpdate: async () => ({
      result: { status: "available", version: "0.8.13", notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
      extractedAppPath: "/tmp/bean-update-xyz/Bean.app",
    }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
  });
  await handlers.check();
  const outcome = await handlers.install();
  expect(installed).toEqual(["/tmp/bean-update-xyz/Bean.app"]);
  expect(outcome).toBeUndefined();
});

test("buildUpdateHandlers.install surfaces an error from installUpdate instead of throwing", async () => {
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-xyz/Bean.app");
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => { throw new Error("EACCES"); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
  });
  expect(await handlers.install()).toEqual({ status: "error", message: "EACCES" });
});

test("buildUpdateHandlers.openReleasesPage delegates to the injected opener", () => {
  const opened: boolean[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => { opened.push(true); },
  });
  handlers.openReleasesPage();
  expect(opened).toEqual([true]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildPendingUpdateStore is not exported` / `buildUpdateHandlers is not exported`.

- [ ] **Step 3: Write the implementation**

In `packages/app/src/channels.ts`, change the `AppInfo` interface and add new types + IPC entries:

```typescript
export interface AppInfo {
  version: string;
  author: string;
  description: string;
  isPackaged: boolean;
}

export type UpdateStatus =
  | { status: "up-to-date" }
  | { status: "available"; version: string; notes: string }
  | { status: "error"; message: string };

export interface InstallUpdateResult { status: "error"; message: string }
```

Add three entries to the `IPC` const (anywhere in the object, e.g. right after `routinesState: "bean:routines-state",`):

```typescript
  checkForUpdate: "bean:check-for-update",
  installUpdate: "bean:install-update",
  openUpdateReleasePage: "bean:open-update-release-page",
```

In `packages/app/src/ipc.ts`, add `UpdateStatus, InstallUpdateResult` to the existing `channels.js` import (the line starting `import { IPC, type Theme, ...`), and add a new import for the app-side updater's outcome type (`updater.ts` doesn't import anything from `ipc.ts` or `channels.ts`, so this doesn't create a cycle):

```typescript
import type { UpdateCheckOutcome } from "./updater.js";
```

Then add near the other store-builder functions (e.g. right after `buildInterruptedRunStore`):

```typescript
// Bridges the two-step manual update flow (check-and-download, then a separate confirmed
// install) across two IPC calls. Unlike the drop-race stores above, there's no push/pull
// race here — just a plain slot passing the extracted bundle's path from one invoke to the
// next in the same About-panel session. Not consumed on get: a failed install can be retried
// against the same already-downloaded bundle without re-checking.
export function buildPendingUpdateStore(): { set: (path: string) => void; get: () => string | undefined } {
  let pending: string | undefined;
  return {
    set: (path) => { pending = path; },
    get: () => pending,
  };
}

export interface UpdateHandlerDeps {
  currentVersion: string;
  checkAndDownloadUpdate: (currentVersion: string) => Promise<UpdateCheckOutcome>;
  installUpdate: (extractedAppPath: string) => Promise<void>;
  pendingUpdateStore: ReturnType<typeof buildPendingUpdateStore>;
  openReleasesPage: () => void;
}

export function buildUpdateHandlers(deps: UpdateHandlerDeps) {
  return {
    check: async (): Promise<UpdateStatus> => {
      const outcome = await deps.checkAndDownloadUpdate(deps.currentVersion);
      if (outcome.result.status === "available") {
        if (outcome.extractedAppPath) deps.pendingUpdateStore.set(outcome.extractedAppPath);
        return { status: "available", version: outcome.result.version, notes: outcome.result.notes };
      }
      return outcome.result;
    },
    install: async (): Promise<InstallUpdateResult | undefined> => {
      const extractedAppPath = deps.pendingUpdateStore.get();
      if (!extractedAppPath) return { status: "error", message: "No update is ready to install — check for updates again." };
      try {
        await deps.installUpdate(extractedAppPath);
        return undefined; // unreachable in practice: installUpdate exits the process on success
      } catch (err) {
        return { status: "error", message: err instanceof Error ? err.message : String(err) };
      }
    },
    openReleasesPage: (): void => deps.openReleasesPage(),
  };
}
```

Extend `RegisterDeps` (add `UpdateHandlerDeps` to the `extends` list):

```typescript
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps, ChatopsHandlerDeps, UpdateHandlerDeps {
```

In `registerIpc`, add (near the other handler-group wiring, e.g. right after the `chatopsHandlers` block):

```typescript
  const updateHandlers = buildUpdateHandlers(deps);
  ipcMain.handle(IPC.checkForUpdate, () => updateHandlers.check());
  ipcMain.handle(IPC.installUpdate, () => updateHandlers.install());
  ipcMain.on(IPC.openUpdateReleasePage, () => updateHandlers.openReleasesPage());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS

Then run the full app typecheck to confirm `RegisterDeps`'s new required fields don't break other callers yet (they will — `main.ts` isn't wired until Task 8, so this is expected to fail typecheck until then):

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: FAIL — `main.ts`'s `registerIpc(ipcMain, {...})` call is missing `currentVersion`, `checkAndDownloadUpdate`, `installUpdate`, `pendingUpdateStore`, `openReleasesPage`. This is expected — Task 8 fixes it. Do not treat this as a Task 6 failure.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): add check-for-update/install-update IPC channels and handlers"
```

---

### Task 7: App — preload bridge + renderer types

**Files:**
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`

**Interfaces:**
- Consumes: `IPC.checkForUpdate`/`installUpdate`/`openUpdateReleasePage`, `UpdateStatus`, `InstallUpdateResult` from `./channels.js` (Task 6).
- Produces: `window.bean.checkForUpdate()`, `window.bean.installUpdate()`, `window.bean.openUpdateReleasePage()`. Task 9 (About panel UI) calls these.

- [ ] **Step 1: Update the preload bridge**

In `packages/app/src/preload.ts`, add `UpdateStatus, InstallUpdateResult` to the existing `channels.js` import, and add three lines inside the `contextBridge.exposeInMainWorld("bean", { ... })` object (e.g. right after the `getAppInfo`/`quitApp` lines):

```typescript
  checkForUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.checkForUpdate),
  installUpdate: (): Promise<InstallUpdateResult | undefined> => ipcRenderer.invoke(IPC.installUpdate),
  openUpdateReleasePage: (): void => ipcRenderer.send(IPC.openUpdateReleasePage),
```

- [ ] **Step 2: Update the renderer's global type**

In `packages/app/src/renderer/bean.d.ts`, add `UpdateStatus, InstallUpdateResult` to the existing `"../channels.js"` import, and add three lines inside the `interface Window { bean: { ... } }` block (e.g. right after `getAppInfo`/`quitApp`):

```typescript
      checkForUpdate(): Promise<UpdateStatus>;
      installUpdate(): Promise<InstallUpdateResult | undefined>;
      openUpdateReleasePage(): void;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: same pre-existing `main.ts` `RegisterDeps` failure from Task 6 (still expected until Task 8) — no *new* errors from preload.ts or bean.d.ts.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts
git commit -m "feat(app): expose the update-check IPC bridge to the renderer"
```

---

### Task 8: App — wire real dependencies in main.ts

**Files:**
- Modify: `packages/app/src/main.ts`

**Interfaces:**
- Consumes: `checkAndDownloadUpdate`, `installAndRelaunch` from `./updater.js` (Tasks 3–5); `buildPendingUpdateStore` from `./ipc.js` (Task 6).
- Produces: a fully-typed `registerIpc(ipcMain, {...})` call (no more missing-fields typecheck error) and `AppInfo.isPackaged` populated from `app.isPackaged`.

- [ ] **Step 1: Add imports**

In `packages/app/src/main.ts`, add `shell` to the existing `electron` import (line 8):

```typescript
import { app, ipcMain, dialog, BrowserWindow, nativeTheme, Notification, Tray, Menu, nativeImage, shell } from "electron";
```

Add `buildPendingUpdateStore` to the existing `./ipc.js` import (line ~24):

```typescript
import {
  registerIpc, buildPlanStore, buildDroppedUrlStore, buildChatPromptStore, buildInterruptedRunStore,
  buildRoutineHandlers, buildPendingUpdateStore, type ChatPromptPayload,
} from "./ipc.js";
```

Add a new import line for the updater module (near the other local imports, e.g. after the `./routine-scheduler.js` import):

```typescript
import { checkAndDownloadUpdate, installAndRelaunch } from "./updater.js";
```

- [ ] **Step 2: Instantiate the pending-update store**

Near the other store instantiations (e.g. right after `const interruptedRunStore = buildInterruptedRunStore();` around line 256):

```typescript
  const pendingUpdateStore = buildPendingUpdateStore();
```

- [ ] **Step 3: Wire the registerIpc deps**

In the `registerIpc(ipcMain, { ... })` call, change the existing `getAppInfo` entry (around line 595) to add `isPackaged`, and add the five new fields (e.g. right after it):

```typescript
      getAppInfo: () => ({
        version: pkg.version,
        author: pkg.author,
        description: pkg.description,
        isPackaged: app.isPackaged,
      }),
      currentVersion: pkg.version,
      checkAndDownloadUpdate: (currentVersion: string) => checkAndDownloadUpdate(currentVersion),
      installUpdate: (extractedAppPath: string) => installAndRelaunch(extractedAppPath),
      pendingUpdateStore,
      openReleasesPage: () => { void shell.openExternal("https://github.com/ScenK/Bean/releases"); },
```

- [ ] **Step 4: Typecheck and build**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: PASS — no errors.

Run: `pnpm --filter @bean/app test`
Expected: PASS — all existing app tests still pass (this task only adds wiring, no new test file).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/main.ts
git commit -m "feat(app): wire the update-check pipeline and isPackaged flag into main.ts"
```

---

### Task 9: App — About panel UI

**Files:**
- Modify: `packages/app/src/renderer/components/about/AboutWindow.tsx`
- Modify: `packages/app/src/renderer/shared.css`

**Interfaces:**
- Consumes: `window.bean.checkForUpdate()`, `window.bean.installUpdate()`, `window.bean.openUpdateReleasePage()` (Task 7); `AppInfo.isPackaged` (Task 6/8).
- Produces: the visible "Check for Updates" flow. Nothing downstream depends on this file.

- [ ] **Step 1: Replace `AboutWindow.tsx`**

Full replacement of `packages/app/src/renderer/components/about/AboutWindow.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import type { AppInfo, Theme, UpdateStatus } from "../../../channels.js";

type UpdateUiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; version: string; notes: string }
  | { phase: "installing" }
  | { phase: "error"; message: string };

export function AboutWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [info, setInfo] = useState<AppInfo | undefined>(undefined);
  const [update, setUpdate] = useState<UpdateUiState>({ phase: "idle" });
  const year = new Date().getFullYear();

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.getAppInfo().then(setInfo);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const checkForUpdates = async (): Promise<void> => {
    setUpdate({ phase: "checking" });
    const result: UpdateStatus = await window.bean.checkForUpdate();
    if (result.status === "up-to-date") setUpdate({ phase: "up-to-date" });
    else if (result.status === "available") setUpdate({ phase: "available", version: result.version, notes: result.notes });
    else setUpdate({ phase: "error", message: result.message });
  };

  const installUpdate = async (): Promise<void> => {
    setUpdate({ phase: "installing" });
    const result = await window.bean.installUpdate();
    // On success the app exits before this resolves — only an error surfaces here.
    if (result?.status === "error") setUpdate({ phase: "error", message: result.message });
  };

  return (
    <div class="bean-dashboard">
      <div class="bean-about">
        <div class="bean-about-name">Bean</div>
        <div class="bean-about-version">v{info?.version ?? "…"}</div>
        <p class="bean-about-desc">{info?.description ?? ""}</p>
        <div class="bean-about-meta">
          <div>Author · {info?.author ?? "Scen.K"}</div>
          <div>© {year} {info?.author ?? "Scen.K"} in San Antonio</div>
        </div>
        {info && !info.isPackaged && (
          <div class="bean-about-update-msg">Updates aren't available in a dev build.</div>
        )}
        {info?.isPackaged && (
          <div class="bean-about-update">
            {update.phase === "idle" && (
              <button class="bean-btn" onClick={checkForUpdates}>Check for Updates</button>
            )}
            {update.phase === "checking" && (
              <button class="bean-btn" disabled>Checking for updates…</button>
            )}
            {update.phase === "up-to-date" && (
              <>
                <div class="bean-about-update-msg">You're up to date.</div>
                <button class="bean-btn bean-btn--ghost" onClick={checkForUpdates}>Check again</button>
              </>
            )}
            {update.phase === "available" && (
              <>
                <div class="bean-about-update-msg">Version {update.version} is available.</div>
                <p class="bean-about-update-notes">{update.notes}</p>
                <button class="bean-btn" onClick={installUpdate}>Install &amp; Relaunch</button>
              </>
            )}
            {update.phase === "installing" && (
              <button class="bean-btn" disabled>Installing…</button>
            )}
            {update.phase === "error" && (
              <>
                <div class="bean-about-update-error">{update.message}</div>
                <button class="bean-btn bean-btn--ghost" onClick={checkForUpdates}>Retry</button>
                <a
                  class="bean-about-update-link"
                  href="#"
                  onClick={(e) => { e.preventDefault(); window.bean.openUpdateReleasePage(); }}
                >
                  View releases on GitHub
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add styles**

Append to `packages/app/src/renderer/shared.css` (after the existing `.bean-about-meta` rules, around line 1258):

```css
.bean-about-update {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.bean-about-update-msg {
  margin-top: 16px;
  font-size: 12px;
  color: var(--bean-text-dim);
}
.bean-about-update-notes {
  max-width: 320px;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--bean-text-dim);
  text-align: left;
}
.bean-about-update-error {
  max-width: 320px;
  font-size: 12px;
  color: #e5484d;
  text-align: center;
}
.bean-about-update-link {
  font-size: 12px;
  color: var(--bean-accent);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: PASS — no errors.

- [ ] **Step 4: Manual smoke test**

Run: `pnpm dev` (from repo root), open Bean, click the tray icon → About. Confirm:
- The version line still renders.
- "Check for Updates" button appears (dev build — per Step 1's JSX this actually shows "Updates aren't available in a dev build" instead, since `app.isPackaged` is `false` in `pnpm dev`). Confirm that message shows instead, and no button.
- No console errors in the About window's devtools.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/components/about/AboutWindow.tsx packages/app/src/renderer/shared.css
git commit -m "feat(app): add Check for Updates flow to the About panel"
```

---

### Task 10: CI — sign releases with the Ed25519 private key

**Files:**
- Create: `packages/app/scripts/sign-release.mjs`
- Modify: `.github/workflows/mac-installer.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone script).
- Produces: a `<zip>.sig` file uploaded as a release asset. Task 5's `checkAndDownloadUpdate` (already implemented) is what consumes this asset at runtime — this task is what produces it.

- [ ] **Step 1: Write the signing script**

Create `packages/app/scripts/sign-release.mjs`:

```javascript
#!/usr/bin/env node
// Signs a release asset with the update's Ed25519 private key so Bean's updater can verify
// authenticity before installing (see
// docs/superpowers/specs/2026-07-14-manual-update-check-design.md and
// .memory/project-manual-update-check.md).
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [, , filePath] = process.argv;
if (!filePath) {
  console.error("usage: sign-release.mjs <file>");
  process.exit(1);
}

const privateKeyPem = process.env.UPDATE_ED_PRIVATE_KEY;
if (!privateKeyPem) {
  console.error("error: UPDATE_ED_PRIVATE_KEY env var is not set");
  process.exit(1);
}

const privateKey = createPrivateKey(privateKeyPem);
const data = readFileSync(filePath);
const signature = sign(null, data, privateKey);
writeFileSync(`${filePath}.sig`, signature.toString("base64"), "utf8");
console.log(`signed ${filePath} -> ${filePath}.sig`);
```

- [ ] **Step 2: Test the script locally with a throwaway keypair**

Run:
```bash
node -e "
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
require('fs').writeFileSync('/tmp/test-priv.pem', privateKey);
require('fs').writeFileSync('/tmp/test-pub.pem', publicKey);
"
echo "test payload" > /tmp/test-asset.txt
UPDATE_ED_PRIVATE_KEY="$(cat /tmp/test-priv.pem)" node packages/app/scripts/sign-release.mjs /tmp/test-asset.txt
node -e "
const { createPublicKey, verify } = require('crypto');
const fs = require('fs');
const pub = createPublicKey(fs.readFileSync('/tmp/test-pub.pem', 'utf8'));
const sig = Buffer.from(fs.readFileSync('/tmp/test-asset.txt.sig', 'utf8'), 'base64');
const data = fs.readFileSync('/tmp/test-asset.txt');
console.log('verified:', verify(null, data, pub, sig));
"
rm /tmp/test-priv.pem /tmp/test-pub.pem /tmp/test-asset.txt /tmp/test-asset.txt.sig
```
Expected: last line prints `verified: true`.

- [ ] **Step 3: Wire the signing step into the release workflow**

In `.github/workflows/mac-installer.yml`, add a step right after the existing `pnpm dist:mac` step (currently line 23-27) and before `actions/upload-artifact`:

```yaml
      - run: node packages/app/scripts/sign-release.mjs packages/app/release/*.zip
        env:
          UPDATE_ED_PRIVATE_KEY: ${{ secrets.UPDATE_ED_PRIVATE_KEY }}
```

Update the `upload-artifact` step's `path` and the `gh release create` command to include the `.sig` file:

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: bean-mac
          path: |
            packages/app/release/*.dmg
            packages/app/release/*.zip
            packages/app/release/*.zip.sig
      - name: Attach to release
        if: startsWith(github.ref, 'refs/tags/')
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "${GITHUB_REF_NAME}" packages/app/release/*.dmg packages/app/release/*.zip packages/app/release/*.zip.sig --generate-notes
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/scripts/sign-release.mjs .github/workflows/mac-installer.yml
git commit -m "ci: sign release zips with the update Ed25519 key and publish the .sig asset"
```

Note: this workflow step will fail at actual release time until `UPDATE_ED_PRIVATE_KEY` is added as a GitHub Actions secret — that's Task 12, a manual/maintainer step, not something this commit can do on its own.

---

### Task 11: Docs — memory entry

**Files:**
- Create: `.memory/project-manual-update-check.md`
- Modify: `.memory/INDEX.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write the memory entry**

Create `.memory/project-manual-update-check.md`:

```markdown
---
name: project-manual-update-check
description: Manual "Check for Updates" flow — Ed25519-signed GitHub Releases, no Sparkle/electron-updater, ad-hoc re-sign on install.
metadata:
  type: project
---

Bean's update flow is fully manual: the About panel's "Check for Updates" button drives
`packages/core/src/updater.ts` (`compareVersions`/`checkForUpdate`/`verifyUpdateSignature` —
pure) and `packages/app/src/updater.ts` (fetch/download/extract/install — IO), wired through
`bean:check-for-update`/`bean:install-update` IPC. No background polling; every step is a
user click.

**Why not Sparkle/electron-updater:** see
`docs/superpowers/specs/2026-07-14-manual-update-check-design.md`. Short version: ad-hoc
signing (matching [safety-mac-adhoc-signing.md](safety-mac-adhoc-signing.md)) is NOT the
blocker it looks like — Sparkle's authenticity check is EdDSA, independent of code-signing
tier — but Sparkle.framework itself has no supported Electron embedding (electron/electron
#5850, #29057, both unresolved). We took the EdDSA idea without the framework: Node's
built-in `crypto` module signs/verifies Ed25519 natively.

**Security model:** a committed Ed25519 public key
(`packages/core/src/update-public-key.ts`) verifies a `.sig` sidecar asset the release
workflow produces via `packages/app/scripts/sign-release.mjs` (private key only in the
`UPDATE_ED_PRIVATE_KEY` GitHub Actions secret, never committed). A failed/missing signature
is a hard stop — Bean never extracts/installs an unverified update. Ad-hoc re-signing the
extracted bundle (`codesign --force --deep --sign -`, same command as `after-sign.mjs`)
still happens before install, but that's only the AMFI "must be signed to execute" bar — it
doesn't substitute for the EdDSA check.

**Install mechanism:** `installAndRelaunch` (`packages/app/src/updater.ts`) does the same
rename-dance Sparkle/Squirrel use — current `Bean.app` → `.old`, extracted bundle → the live
path (EXDEV falls back to a recursive copy), roll back on failure — then `app.relaunch();
app.exit()`. Gated on `app.isPackaged`; dev builds never attempt it.

**Key rotation:** losing the private key strands existing installs — they can't verify
future updates against a new key. Recovery is a new build with a new public key that
existing installs can't self-migrate to; accepted as a rare manual-recovery case.
```

- [ ] **Step 2: Add it to the index**

In `.memory/INDEX.md`, add a line under the `## project — ongoing work context` section (after the last existing `project-*` entry):

```markdown
- [project-manual-update-check](project-manual-update-check.md) — Ed25519-signed manual update flow (no Sparkle/electron-updater); see the design spec for why.
```

- [ ] **Step 3: Commit**

```bash
git add .memory/project-manual-update-check.md .memory/INDEX.md
git commit -m "docs: add memory entry for the manual update-check flow"
```

---

### Task 12: Maintainer setup — generate the production keypair (manual, not autonomous)

This task is **not** something to execute unattended — generating and handling a private
key touches credential-like material, and adding a GitHub Actions secret is an account/repo
settings change. Do both with the user in the loop, one step at a time, rather than running
`gh secret set` autonomously.

**Files:**
- Modify: `packages/core/src/update-public-key.ts` (replace the placeholder key)

- [ ] **Step 1: Generate a real keypair locally (with the user watching)**

Run:
```bash
node -e "
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
console.log('PUBLIC KEY (commit this):');
console.log(publicKey);
console.log('PRIVATE KEY (give to the user — GitHub Actions secret, never commit):');
console.log(privateKey);
"
```

- [ ] **Step 2: Replace the placeholder public key**

Edit `packages/core/src/update-public-key.ts`: replace the placeholder PEM block and comment with the newly generated public key, and update the comment to remove the "PLACEHOLDER" language (note instead which date/who generated it, if useful).

- [ ] **Step 3: Hand the private key to the user, don't set the secret yourself**

Show the user the private key PEM output from Step 1 and ask them whether they want to add it
as the `UPDATE_ED_PRIVATE_KEY` secret themselves (Settings → Secrets and variables → Actions,
on `github.com/ScenK/Bean`), or explicitly authorize running `gh secret set
UPDATE_ED_PRIVATE_KEY --repo ScenK/Bean` on their behalf. Do not run that command without an
explicit go-ahead in the same conversation.

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

```bash
git add packages/core/src/update-public-key.ts
git commit -m "chore: replace the placeholder update-signing public key with the production one"
```

---

### Task 13: End-to-end verification (manual, required before calling this done)

Per `AGENTS.md`'s packaged-build verification bar — this feature touches app boot, Electron
resources, and the packaged/dev-mode difference, so unit tests and typecheck are not
sufficient on their own.

- [ ] **Step 1: Full validation gate**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (both exit 0).

- [ ] **Step 2: Real packaged build with a throwaway keypair**

1. Generate a throwaway Ed25519 keypair (same command as Task 12, Step 1) — do **not** reuse
   the production key for this dry run.
2. Temporarily swap `UPDATE_PUBLIC_KEY_PEM` in `packages/core/src/update-public-key.ts` to
   the throwaway public key (do not commit this swap — revert after the test).
3. Bump the version in `packages/app/package.json` down by a patch (e.g. if current is
   `0.8.12`, temporarily set the *installed* build to `0.8.11` so the throwaway release
   below looks newer) — or simpler: install today's current published `Bean.app` from
   `/Applications` (whatever version is already there) and leave `package.json` alone; the
   throwaway release only needs a `tag_name` higher than the currently-installed app's
   version.
4. Run `pnpm dist:mac` from the repo root.
5. Sign the resulting zip: `UPDATE_ED_PRIVATE_KEY="$(cat <throwaway-private-key-file>)" node packages/app/scripts/sign-release.mjs packages/app/release/Bean-*-arm64-mac.zip`.
6. Create a throwaway pre-release on a scratch/fork repo (not `ScenK/Bean`'s real releases)
   with the `.zip`, `.dmg`, and `.zip.sig` as assets, tagged higher than the installed
   version.
7. Temporarily point `REPO` in `packages/app/src/updater.ts`'s `fetchLatestRelease` at that
   scratch repo (do not commit this either).
8. Rebuild (`pnpm dist:mac`), install the resulting `Bean.app` to `/Applications` (replacing
   whatever's there), launch it, open About, click **Check for Updates**.
9. Confirm: the throwaway version + notes appear, clicking **Install & Relaunch** swaps the
   bundle and the app comes back up at the new version (check About again after relaunch).
10. Revert every temporary swap from steps 2, 3, and 7 (`git diff` should be clean before
    moving on) and delete the scratch pre-release/repo.

- [ ] **Step 3: Report results**

Confirm to the user: real `pnpm dist:mac` build tested, check → download → verify →
install → relaunch exercised against a real installed `Bean.app`, no errors, reverted all
scratch state. This satisfies the spec's Testing section and `AGENTS.md`'s packaged-build bar.
