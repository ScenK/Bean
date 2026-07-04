// Rasterizes the bean mark (same paths as BEAN_SVG in src/renderer/orb.ts) into:
//   assets/beanTemplate.png (+@2x)  — monochrome macOS tray template image
//   build/icon.icns                 — full-color app icon (electron-builder default path)
// Run with the workspace Electron:  pnpm --filter @bean/app exec electron scripts/generate-icons.mjs
// Outputs are committed; this is a dev tool, not part of the build.
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

// Bean geometry copied from BEAN_SVG in src/renderer/orb.ts — keep in sync.
const BODY = "M18 3C11 3 5.5 8 5 15C4.5 22 9 29 16 31.5C23 34 30 29.5 32 22.5C34 15.5 30 7 24 4.5C22.3 3.5 20.2 3 18 3Z";
const CREASE = "M18 7C18 7 15 14 18 22C21 14 18 7 18 7Z";
const CREASE_LINE = "M12 9C10 12 10 17 12 20";
const GLOSS = `<ellipse cx="14" cy="10" rx="3" ry="2" transform="rotate(-20 14 10)"`;

// Tray: alpha is all macOS uses for template images — crease shapes punch holes via a mask.
// Canvas size N sets the glyph size (smaller N = bigger bean); keep the bean centered with
// translate((N-36)/2) in both axes, and keep the <rect> at N×N. Rasterized large and
// downscaled with sips for crisp edges at 16/32px.
function traySvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 30 30">
  <mask id="m">
    <g transform="translate(-3 -3)">
      <path d="${BODY}" fill="#fff"/>
      <path d="${CREASE}" fill="#000"/>
      <path d="${CREASE_LINE}" stroke="#000" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </g>
  </mask>
  <rect width="30" height="30" fill="#000" mask="url(#m)"/>
</svg>`;
}

// App icon: light-theme ("hearth") orb palette baked in — .icns can't follow the runtime theme.
// Layout follows the macOS Big Sur grid: 824px rounded square centered on a 1024px canvas.
function appIconSvg(px) {
  const s = px / 1024;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="oklch(0.975 0.012 70)"/>
  <g transform="translate(512 512) scale(${(824 * 0.72) / 36}) translate(-18 -18)">
    <path d="${BODY}" fill="oklch(0.71 0.16 50)"/>
    <path d="${CREASE_LINE}" stroke="oklch(0.85 0.12 74)" stroke-opacity="0.35" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    <path d="${CREASE}" fill="oklch(0.58 0.16 32)" fill-opacity="0.5"/>
    ${GLOSS} fill="#fff" fill-opacity="0.28"/>
  </g>
</svg>`;
}

let win;
async function renderPng(svg, px) {
  win ??= new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.setContentSize(px, px);
  const html = `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`;
  const tmp = join(tmpdir(), `bean-icon-${px}-${svg.length}.html`);
  writeFileSync(tmp, html);
  await win.loadFile(tmp);
  rmSync(tmp, { force: true });
  // One extra frame so the offscreen compositor has painted before capture.
  await new Promise((r) => setTimeout(r, 200));
  return (await win.webContents.capturePage({ x: 0, y: 0, width: px, height: px })).toPNG();
}

process.on("unhandledRejection", (err) => {
  console.error(err);
  app.exit(1);
});

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.dock?.hide();

app.whenReady().then(async () => {
  const assetsDir = join(appDir, "assets");
  const buildDir = join(appDir, "build");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  const trayMaster = join(assetsDir, "beanTemplate-master.png");
  writeFileSync(trayMaster, await renderPng(traySvg(256), 256));
  execFileSync("sips", ["-z", "16", "16", trayMaster, "--out", join(assetsDir, "beanTemplate.png")], { stdio: "ignore" });
  execFileSync("sips", ["-z", "32", "32", trayMaster, "--out", join(assetsDir, "beanTemplate@2x.png")], { stdio: "ignore" });
  rmSync(trayMaster);
  console.log("wrote assets/beanTemplate.png (+@2x)");

  const master = await renderPng(appIconSvg(1024), 1024);
  const iconset = join(buildDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  writeFileSync(join(iconset, "icon_512x512@2x.png"), master);
  const masterPath = join(iconset, "icon_512x512@2x.png");
  for (const [size, name] of [
    [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"], [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"], [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"], [512, "icon_512x512.png"],
  ]) {
    execFileSync("sips", ["-z", String(size), String(size), masterPath, "--out", join(iconset, name)], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
  rmSync(iconset, { recursive: true });
  console.log("wrote build/icon.icns");
  app.exit(0);
});
