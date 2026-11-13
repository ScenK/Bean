# convention: every channel is in the service contract

`app/src/channel-contract.ts` (`CHANNEL_CONTRACT`, #807) classifies each `IPC` channel as:

- **core** — the host's own work (chats, memory, notes, routines, config, bots); runs on any host.
- **host-bound** — needs the host machine's desktop; names the capability it needs
  (`systemControls`, `terminalHandoff`, `pty`, `pathOpen` — `@bean/host` `CAPABILITIES`).
- **shell** — the shell's own windows, theme, updates and open-this-window stores.

A new channel needs an entry (`satisfies Record<keyof typeof IPC, …>` fails typecheck;
`channel-contract.test.ts` fails the tests). Core and host-bound entries list hand-written guards
(`@bean/host` `guard`) for the call's arguments — or, for a push, its one payload. The Electron
adapter runs them before a handler (`registerIpc` → `guardIpc`: an invoke rejects, a send drops)
and before a push is delivered (`createPush`). Guards are shallow on purpose — the handlers still
validate ids, paths and enums. A wrong guard breaks the feature silently (dropped send), so match the
preload's types exactly; optional trailing args are `opt(…)`.

Split a channel whose handler does both host and shell work rather than classifying it twice. The
chat-mount checks (`chats.key`) are authorization, not shell work; none needed splitting at #807.

The handshake (`IPC.handshake`, `@bean/host` `buildHandshake`/`checkHandshake`) carries
`CONTRACT_VERSION`, the core version, platform and capabilities; bump `CONTRACT_VERSION` on any
breaking argument/result/event change. `checkHandshake` reports a version mismatch as `reason:
"version"`, apart from a malformed reply. Nothing in the renderer consumes it yet (#810/#812 will).
