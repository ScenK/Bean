# Attachment lifecycle (remote shells)

`@bean/host`'s `attachments.ts` (#808) is how a **remote** shell holds chats; the in-process Electron
shell never attaches, so local behavior (window close releases at once) is unchanged.

- **One shell per core.** `attach(shellId, send)` sends `revoked` to whoever is attached *before*
  returning the new generation. The displaced shell's chats are not adopted — they get their own grace.
  `shellId` is the persistent per-install UUID (`shellClientId(file)`); a reconnect from the same
  install keeps its (negative) client id and its chats.
- **Generations.** Every remote request goes through `run(gen, fn)` — checked before *and after* its
  async work; a stale generation throws `StaleAttachmentError`.
- **Disconnect ≠ release.** No `heartbeat` for `HEARTBEAT_TIMEOUT_MS` = disconnected: Bean's in-flight
  turn is aborted, delegates/live sessions keep running for `DISCONNECT_GRACE_MS` (30 min, a separate
  constant from `LIVE_SESSION_IDLE_MS`). Expiry runs `expireClient`: a host-side close catch-up from the
  turns the host saw (incognito → nothing), then release (cancels only that client's work). `detach` is
  the deliberate quit: release now, the shell sends its own catch-up first. Routines/bots never depend on a shell.
- **Replay.** A remote chat's pushes get a per-mount `seq` and sit in a buffer bounded by `REPLAY_LIMIT`
  — only `output` lines are evicted; everything else (a delegate's result, a live `turn`'s answer, prose,
  receipts, ends) survives until acked. Don't narrow that to "terminal events": a live answer rides on
  `turn`, not `ended`. Nothing is delivered between `attach` and `resume(gen, acks)`, which replays past
  the acks once per connection (a repeat is a no-op). Heartbeat acks trim. In memory only, never
  persisted. Requests are never replayed (process starts included).
- **Catch-up gap:** the host's close transcript holds only Bean `chat()` turns; agent-mode input isn't
  in it (liveStart/liveSend carry no typed-vs-skill provenance).
- **Loopback dedupe** is in the renderer: `applyDelegateEventToItems` ignores events for a settled task,
  so a replayed `done` can't loop a result back twice.
