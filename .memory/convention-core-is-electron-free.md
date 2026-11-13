# convention: keep @bean/core pure and Electron-free

`@bean/core` must never import `electron` or reach for ambient IO. Everything it needs is
**injected**:

- `converse()` takes a `deps.chat` function, not an OpenAI client.
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

**`@bean/host` (#803, #804)** is the second Electron-free layer: the IPC handler builders (notes,
memory, skills, skill proposals, persona, projects, routines, todos, destinations, config view)
and, since #804, the stateful host itself — `createHost()` builds the chat mounts and turns
(`createChatSessions`), the delegate/live/status registries, runtime config, action tools, the
routine builder, the scheduler lease + reminder loop + sprout scheduler — that a headless host
will serve too. Its seams to the shell: `push` (mount-tagged `HostPush` kinds, mapped to channels
by `app/src/push.ts`'s `hostPush`), `onJobs`, `notification`, `isChatClient`, `onQuit`,
`firstAutoMemory`, `onChatRelease` (the app's pty terminals stay shell-owned). `main.ts` builds
only the host, the IPC adapter and shell pieces (windows, tray, keep-awake, theme, updater, pty,
bots until #805). It depends on `@bean/core` only — `electron` isn't a
dependency, and `host/__test__/electron-free.test.ts` fails on any import. Anything that needs
a dialog, Finder, the browser or a window goes through the injected `ShellOps` interface
(`host/src/shell-ops.ts`), implemented once in `app/src/shell-ops.ts`. The app's `registerIpc`
only wires channels (`channels.ts`) to `host.handlers`; `ipc.ts` imports `electron` for types only.
