# The desktop shell boots with or without a core (#810)

`main.ts` boots the **shell** (avatar, tray, theme, updater, windows) always and the **local core**
(`~/.bean`, `createHost()`, terminals, outbox claim) only when `userData/cores.json` selects it
(`core-store.ts`: `{ "selected": "local" | <remote id> | null, "cores": [...] }`; no/corrupt file = local on
macOS, none elsewhere; a saved `"local"` off macOS also loads as none — local is macOS-only). A remote selection boots the remote adapter instead ([convention-remote-core-shell](convention-remote-core-shell.md)).

- With no core, nothing may touch `~/.bean`: tray rows that read it (proposals, Chat Bots) are hidden
  and the avatar log goes to `userData/logs/`. The no-core e2e (`no-core.e2e.ts`) asserts the dir is
  never created — a new boot-time read of `beanDir()` must sit inside the local-core branch.
- IPC is two halves: `registerShellIpc` (shell-owned channels only — a test enforces it) and
  `registerIpc` (core + host-bound, local core). With no core, `registerNoCore` makes every core and
  host-bound invoke reject with the one `NO_CORE` error; renderers test it with `isNoCore(err)`.
- `openComponent` sends every kind outside `SHELL_ONLY_KINDS` (`about`, `cores`) to the Add a core
  panel (`cores`), so no core window ever mounts without a core. A new window that needs no core
  goes in that list; the avatar learns no-core from its boot `handshake` rejection.
- Every core switch ("Use this Mac", a tray Core pick) saves the choice and `app.relaunch()`es — no
  in-place switch; under `pnpm dev` the relaunched app is no longer the dev runner's child.
