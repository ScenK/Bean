# The shell on a remote core (#811)

`userData/cores.json` lists remote cores (`user@host`, optional Docker container — regex-checked, never a
key); selecting one boots `remote-core.ts` instead of the local core.

- **One ssh child, fixed argv** (`core-store.ts` `sshArgs`): `BatchMode=yes`, `StrictHostKeyChecking=yes`,
  `ServerAliveInterval`, `--` before the host. The remote command is joined by the remote shell, so host
  and container must stay regex-checked (no spaces, `;`, `$`, leading `-`). Never-attached failures show
  ssh's last stderr line + `ssh-copy-id <host>` (the one-time setup).
- **Adapter** (`registerRemoteIpc`): `REMOTE_OPS` channels go over the wire (both `handle` and `on` are
  registered — the preload decides which fires); other core channels reject until #812 gates the UI;
  `handshake` answers from the attach reply. Mounts → window ids are tracked here for push routing; every
  (re)attach re-sends `chatAttach` (a chat opened while reconnecting never reached the core).
- **States** (`CoreStatus`, pushed on `coreStatusChanged`): reconnecting retries with backoff and leaves the
  composer read-only; `revoked` (takeover) and `mismatch` never retry on their own — Take back / switch.
- **Switch and quit go through the chat's Keep/Stop card** (`closeChatThen`; "Keep working" sends
  `chatCloseKept` to call it off), then relaunch / detach. A remote quit is a deliberate `detach`.
- Keep-awake: delegate `started`/`output` and live events (until `ended`) on the wire hold it
  (`keepAwake.setWorking`), including while reconnecting.
- e2e `remote-core.e2e.ts` puts a fake `ssh` on PATH that speaks the wire — use it for new remote UI.
