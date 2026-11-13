import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../app/package.json", import.meta.url), "utf8"));

// bean-core as one self-contained file (the container ships no node_modules). It overwrites tsc's
// unbundled dist/bean-core.js on purpose: same path in the checkout and the image.
await build({
  entryPoints: ["src/bean-core.ts"],
  outfile: "dist/bean-core.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  // The handshake's core version: the app's, so a shell and a core from one release match.
  define: { "process.env.BEAN_CORE_VERSION": JSON.stringify(version) },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
