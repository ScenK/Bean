// electron-builder afterSign hook. Ad-hoc codesigns the packaged .app so the
// arm64 binary is executable at all (macOS refuses to run unsigned arm64
// code) and Gatekeeper falls back to its standard "downloaded from the
// internet, open it?" prompt instead of the harder "app is damaged" dialog
// that has no Open option. This is NOT a Developer ID signature and does not
// satisfy notarization — it only clears the "must be signed to execute" bar.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
}
