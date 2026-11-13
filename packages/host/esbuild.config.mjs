import { build } from "esbuild";

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
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
