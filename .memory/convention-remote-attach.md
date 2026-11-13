# Remote attach: unix socket + stdio bridge, default-deny

`@bean/host` `remote.ts` (#809) is how a shell on another machine reaches a `bean-core`.

- **No TCP, ever.** The core listens only on `coreSocketFile(dir)` (`~/.bean/core.sock`, 0600), and
  `listenRemote` refuses unless the data dir is 0700 and owned by this user. Remote = `ssh <host>
  bean-core attach` (stdio piped byte for byte to the socket). A forwarded TCP port would give any
  local process or web page on the shell machine owner-level power, so don't add one "for convenience".
- **Wire:** 4-byte big-endian length + UTF-8 JSON. The cap (`MAX_FRAME_BYTES`) is checked on the header
  before the body is buffered; queued output over `MAX_OUTBOX_BYTES` drops the connection (the
  attachment replay catches up); `MAX_IN_FLIGHT` calls per connection. The first frame must be
  `{type:"attach", shellId, contract}` — nothing runs before it.
- **Default deny:** only `REMOTE_OPS` run. Each must be a `core` channel in `CHANNEL_CONTRACT` with the
  same arity (`channel-contract.test.ts` checks). Never add config/API-key reads, `saveConfig`, path
  opens, pty or `launch`. A new remote op = one entry + its guards (same order as the IPC channel).
- **A socket close is not a detach:** the heartbeat watchdog disconnects and the chats get the grace
  ([convention-attachment-lifecycle](convention-attachment-lifecycle.md)).
- A live socket isn't replaced (a second core on the same dir runs without one); a stale one is.
