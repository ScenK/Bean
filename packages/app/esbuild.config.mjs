import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";

const watchMode = process.argv.includes("--watch");

const common = { bundle: true, platform: "node", format: "esm", target: "node24",
  external: ["electron"], sourcemap: true };

// Main runs as ESM (Electron 28+ supports an ESM main entry).
const mainOpts = { ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" };

// Preload MUST be CommonJS: Electron's sandboxed preload loader does not support
// ESM `import` statements. The package is `"type": "module"`, so a `.js` file would
// be treated as ESM — hence the `.cjs` extension.
const preloadOut = "dist/preload.cjs";
const preloadOpts = {
  ...common, format: "cjs", entryPoints: ["src/preload.ts"], outfile: preloadOut,
  // Runs after esbuild has actually flushed the output file, unlike a check placed
  // right after build()/watch() resolves (which can race the write in watch mode).
  plugins: [{ name: "check-preload-cjs", setup(b) { b.onEnd(() => checkPreloadIsCjs()); } }],
};

const rendererOpts = { ...common, platform: "browser", jsx: "automatic", jsxImportSource: "preact",
  entryPoints: [
    "src/renderer/avatar.ts",
    "src/renderer/components/chat/index.tsx",
    "src/renderer/components/skills/index.tsx",
    "src/renderer/components/persona/index.tsx",
    "src/renderer/components/projects/index.tsx",
    "src/renderer/components/notes/index.tsx",
    "src/renderer/components/plan/index.tsx",
    "src/renderer/components/settings/index.tsx",
    "src/renderer/components/about/index.tsx",
  ],
  outdir: "dist/renderer" };

function checkPreloadIsCjs() {
  const preloadSrc = readFileSync(preloadOut, "utf8");
  if (/^\s*import\s/m.test(preloadSrc) || /^\s*export\s/m.test(preloadSrc)) {
    throw new Error(`${preloadOut} contains ESM syntax — Electron preload must be CommonJS`);
  }
}

// Component windows share one HTML shell that only differs by which bundle it loads;
// generate those at build time. avatar.html is genuinely custom and stays a real file.
const componentHtml = (name) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${name[0].toUpperCase()}${name.slice(1)}</title>
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="shared.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="components/${name}/index.js"></script>
  </body>
</html>
`;

// html/css files are copied as-is, not bundled by esbuild — copy on every (re)build.
function copyStaticAssets() {
  mkdirSync("dist/renderer", { recursive: true });
  cpSync("src/renderer/avatar.html", "dist/renderer/avatar.html");
  for (const f of ["chat", "skills", "persona", "projects", "notes", "plan", "settings", "about"]) {
    writeFileSync(`dist/renderer/${f}.html`, componentHtml(f));
  }
  for (const f of ["theme.css", "orb.css", "avatar-box.css", "shared.css", "bubble-menu.css", "drag-bloom.css"]) {
    cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
  }
}

if (!watchMode) {
  await build(mainOpts);
  await build(preloadOpts);
  await build(rendererOpts);
  copyStaticAssets();
} else {
  const [mainCtx, preloadCtx, rendererCtx] = await Promise.all([
    context(mainOpts), context(preloadOpts), context(rendererOpts),
  ]);
  await Promise.all([mainCtx.watch(), preloadCtx.watch(), rendererCtx.watch()]);
  copyStaticAssets();
  // esbuild doesn't watch files it merely copies, so re-copy by hand on change.
  watch("src/renderer", { recursive: true }, (_event, filename) => {
    if (filename && /\.(html|css)$/.test(filename)) copyStaticAssets();
  });
  console.log("esbuild: watching for changes…");
}
