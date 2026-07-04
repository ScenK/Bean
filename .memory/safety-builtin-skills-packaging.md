# Built-in skills need explicit packaging — `projectBeanDir()` alone doesn't ship them

`projectBeanDir()` (`packages/core/src/config.ts`) finds the repo-shipped `<repo-root>/.bean`
by walking up three directories from its own compiled file via `import.meta.url`. That only
resolves correctly in dev/`pnpm build`, where `dist/main.js` sits three levels below the repo
root. Packaged (`pnpm dist:mac`), `main.js` lives inside `Bean.app/Contents/Resources/`, so the
walk lands outside the app bundle — and `<repo-root>/.bean` was never copied into the bundle in
the first place (`packages/app/package.json`'s electron-builder `files` list only had
`dist/**`, `assets/**`, `package.json`).

Fix: `package.json`'s `build.extraResources` copies `../../.bean` → `Resources/builtin`, and
`main.ts` picks the dir at runtime:

```ts
const projectDir = app.isPackaged ? join(process.resourcesPath, "builtin") : projectBeanDir();
```

If you add more repo-shipped content under `<repo-root>/.bean` (e.g. a project `persona.json`),
no further packaging change is needed — the whole `.bean` folder is mirrored to
`Resources/builtin`. But if you ever change how `projectDir` is resolved, verify with an actual
`pnpm dist:mac` and check `Bean.app/Contents/Resources/builtin/skills/*.md` exists — typecheck
and unit tests can't catch this class of bug since they never touch `app.isPackaged` or the
real electron-builder output.
