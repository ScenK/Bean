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
