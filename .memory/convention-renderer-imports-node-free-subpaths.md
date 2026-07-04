# convention: renderer imports core values only from node-free subpaths

Renderer code (`app/src/renderer/**`, bundled by esbuild with `platform: "browser"`) must
**not** import runtime *values* from the `@bean/core` barrel (`from "@bean/core"`). The barrel
(`index.ts`) re-exports node-only modules (`skill-library` → `node:fs`, `config`, `launcher`,
`runner`), so a value import pulls those into the browser bundle and esbuild dies with
`Could not resolve "node:fs/promises"` (and friends).

Rules:
- **Type-only** imports from the barrel are fine — `import type { Skill, DragKind } from "@bean/core"`
  is erased at build, so it never reaches esbuild's resolver.
- For **values** the renderer needs (e.g. `composePrompt`, `bestProjectForSkill`, `setFrontmatter`),
  import from a **node-free subpath**: `@bean/core/prompt`, `@bean/core/project-select`,
  `@bean/core/frontmatter`. Each is a pure module with no `node:*` imports and its own `exports`
  entry in `packages/core/package.json`.
- Need a new pure helper in the renderer? Put it in (or split it into) a node-free module, add a
  subpath to `package.json` `exports`, and import from that subpath — don't reach through the barrel.

**Why the gate is silent until you run the app:** `pnpm test` and `pnpm typecheck` both pass
because TypeScript resolves the barrel types fine. Only the esbuild bundle (`pnpm build` / `pnpm dev`)
enforces the browser boundary. So a bad value import passes CI-ish checks and only breaks
`pnpm dev`. This bit us when the Skills panel enable toggle imported `setFrontmatter` from the
barrel — the fix was to move it to `@bean/core/frontmatter`.

Related: [[convention-core-is-electron-free]] (core stays pure) and
[[safety-preload-must-be-cjs]] (the other esbuild-bundle boundary that only fails at build time).
