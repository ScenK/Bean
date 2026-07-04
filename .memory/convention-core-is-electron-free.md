# convention: keep @bean/core pure and Electron-free

`@bean/core` must never import `electron` or reach for ambient IO. Everything it needs is
**injected**:

- `route()` takes a `deps.chat` function, not an OpenAI client.
- `runOpencode()` takes an injectable `SpawnFn` (defaults to `node:child_process.spawn`).
- config/skills/projects loaders take explicit file paths, not `~/.bean` lookups.

**Why:** this is what lets the core unit tests run under plain vitest with fake `chat`/spawn
functions and no Electron, no network, no real filesystem fixtures. The `app/` package is the
only place that wires in the real OpenAI client, real `spawn`, real `~/.bean` paths, and
Electron windows.

When adding logic: if it's pure routing/IO that could be tested in isolation, it belongs in
`core` as a dependency-injected function. If it's Electron window/IPC wiring, it belongs in
`app/`. Don't blur the two — a single `electron` import in `core` breaks the test setup for
the whole package.
