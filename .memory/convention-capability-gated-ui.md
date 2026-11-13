# The UI follows the core's capabilities (#812)

`renderer/shared/capabilities.ts` `useCapabilities()` reads the handshake once per window: `has(cap)`,
the core's `platform`, and the remote `host`. A remote core never `has` a host-bound capability (the
remote adapter refuses them all — a path, pty or Terminal on another machine means nothing here); a
local core is assumed to have them until its handshake answers.

- **Gated:** pty pane + toggle (`pty`); Cmd+click paths/anchors (`pathOpen`; URLs need `pty`'s
  `terminalOpenLink`); Show/Reveal in Finder become Copy path; project Browse… and launch chips;
  Settings' Terminal/Editor rows (`terminalHandoff`); system controls only when `platform === "darwin"`,
  named for the core host. A dropped/inserted local path is refused with a hint; images/PDFs still attach.
- **Settings saves a patch** (`ConfigUpdate = Partial<ConfigFields>`, `runtime.apply` merges): only the
  fields the window shows, and the key only once edited — an omitted key is kept. Don't go back to
  sending the whole form; a remote `getConfig` returns `openaiApiKey: ""`.
- **Desktop `runAvailable`** is per client: `createHost` passes `!attachments.isClient(c)`, so a remote
  chat gets no terminal skill in `propose_run` and routes to a delegate ([safety-chatops-no-propose-run](safety-chatops-no-propose-run.md)).
- Delegate cards on a remote core say where they run and that they stop 30 min after a disconnect.
- New host-bound UI: gate it with `useCapabilities().has(...)` and extend `remote-core.e2e.ts`'s
  capability test.
