import { createPublicKey, verify } from "node:crypto";

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

export type CoreUpdateCheck =
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string; tarUrl: string; sigUrl: string }
  | { status: "error"; message: string };

/** A version string that is safe as a directory name (no `/`, never `.` or `..`) — the same set
 * install.sh accepts from `--version`. */
const CORE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

/** The headless core's counterpart of `checkForUpdate` (#837): newer than `currentVersion`, with
 * its `bean-core-<ver>.tar.gz` and `.sig` attached. Pure. */
export function checkForCoreUpdate(currentVersion: string, release: GithubReleaseInfo): CoreUpdateCheck {
  const version = release.tagName.replace(/^v/, "");
  if (!CORE_VERSION_RE.test(version)) return { status: "error", message: `Release tag ${JSON.stringify(release.tagName)} isn't a version.` };
  if (compareVersions(version, currentVersion) <= 0) return { status: "up-to-date", version };
  const name = `bean-core-${version}.tar.gz`;
  const tar = release.assets.find((a) => a.name === name);
  if (!tar) return { status: "error", message: `Release ${release.tagName} has no ${name}.` };
  const sig = release.assets.find((a) => a.name === `${name}.sig`);
  if (!sig) return { status: "error", message: `Release ${release.tagName} is missing ${name}.sig.` };
  return { status: "available", version, tarUrl: tar.browserDownloadUrl, sigUrl: sig.browserDownloadUrl };
}

/** Checks an unpacked core's `--version` line (`bean-core <ver> contract <n>`) before anything
 * switches to it: the version the release promised, and — when `contract` is given (a shell's
 * update, which must reattach afterwards) — the same contract. Returns why not, or undefined. */
export function checkCorePreflight(output: string, expect: { version: string; contract?: number }): string | undefined {
  const m = /^bean-core (\S+) contract (\d+)$/.exec(output.trim());
  if (!m) return `The new core's --version printed ${JSON.stringify(output.trim().slice(0, 200))}.`;
  if (m[1] !== expect.version) return `The new core reports version ${m[1]}, not ${expect.version}.`;
  if (expect.contract !== undefined && Number(m[2]) !== expect.contract) {
    return `The new core speaks contract v${m[2]}, this one v${expect.contract}; update both the shell and the core.`;
  }
  return undefined;
}

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
