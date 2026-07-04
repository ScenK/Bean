# safety: the Electron preload must be CommonJS

`@bean/app` is `"type": "module"`, but Electron's sandboxed preload loader **cannot load
ESM** — `import`/`export` in a preload silently breaks the `contextBridge` exposure, so
`window.bean` never appears in the renderer and every `route`/`run` call fails.

**Why it's load-bearing:** `esbuild.config.mjs` emits the preload as `dist/preload.cjs`
(CJS format, `.cjs` extension so the `"type": "module"` package doesn't treat it as ESM)
and then **asserts** no `import`/`export` survived the bundle, throwing at build time if it
did. `windows.ts` references `preload.cjs` by that exact name.

Don't:
- add an `export` to `src/preload.ts` (the build guard will throw),
- change the preload output to `.js` or ESM format,
- rename `preload.cjs` without updating `windows.ts`.

Keep the preload a thin CJS bridge; put real logic in `@bean/core` or the main process.
