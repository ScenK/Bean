# Stopping Bean's own chat turn (desktop, #740)

- **Per-mount controller in the host.** `createChatSessions` (`host/src/chat-sessions.ts`) keeps `beanTurns: Map<mountKey, { turnId, ctl }>`,
  set **synchronously** in its `chat()` before any await (a Stop during the loaders still
  lands) and deleted in a `finally` only if it is still that turn. The signal rides
  `buildChatHandler` → `converse({ signal })` (core side: `convention-action-tools.md`).
- **`chatStop(mountId, turnId)`** is fire-and-forget, gated by `tryKey`, and aborts only on a
  `turnId` match — a late Stop never kills the next turn. `release` aborts too (window close
  stops the brain request; close-time memory catch-up still runs).
- **A `stopped` result skips `captureTurn`** and ends the task bubble with no error. The renderer
  renders it on its own path: receipts, then a `Stopped by you.` status; an attaching PDF is
  unpinned (it may be what hung), an earlier-read PDF stays pinned.
- **Esc Esc target order:** the live turn first (banner), else Bean's turn (working row) —
  `ChatSession` computes `StopTarget { key, kind, stopping }`. The arm stores the target's `key`
  and is *derived* (`escArmedKey === stopTarget.key`), not reset by a `useEffect`: Preact runs
  effects after paint, so an effect-based disarm raced the next keypress and wiped a fresh arm.
