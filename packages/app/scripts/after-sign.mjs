// electron-builder afterSign hook. Codesigns the packaged .app — macOS refuses to run unsigned
// arm64 code at all.
//
// With BEAN_SIGN_IDENTITY set (a codesigning identity's SHA-1, optionally in BEAN_SIGN_KEYCHAIN —
// CI imports the self-signed cert from scripts/make-signing-cert.sh), the designated requirement
// is `identifier + certificate leaf`, which stays the same across releases, so macOS privacy
// grants (TCC: App Management, Accessibility, …) survive updates. Without it (local builds) the
// signature is ad-hoc: the requirement is the cdhash, which changes every build and resets those
// grants. Neither is a Developer ID signature — Gatekeeper still asks on first open.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = process.env.BEAN_SIGN_IDENTITY || "-";
  const keychain = process.env.BEAN_SIGN_KEYCHAIN;

  execFileSync("codesign", [
    "--force", "--deep", "--sign", identity,
    ...(keychain ? ["--keychain", keychain] : []),
    appPath,
  ], { stdio: "inherit" });
}
