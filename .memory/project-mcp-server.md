# Bean as a local MCP server (#225)

Claude Code / Codex / OpenCode / Claude Desktop reach Bean's **data and actions** (never
`converse()`) over MCP. `Bean.app` listens on `~/.bean/mcp.sock` (`mcp-server.ts`: one SDK
`Server` per connection over `StdioServerTransport(socket, socket)`); each client spawns
`<Bean exe> Resources/mcp-shim.cjs` with `ELECTRON_RUN_AS_NODE=1` (no system node, no
single-instance lock). Tool catalog lives once in `mcp-tools.ts` (node-free; the shim and the
Settings "Connect AI apps" snippets import it).

- **Shim (`mcp-bridge.ts`)** answers `initialize`/`tools/list` itself while Bean is closed and
  fails every `tools/call` with "Bean isn't running". When Bean appears it replays the cached
  initialize (swallowing that reply); a call in flight when the socket dies gets an error,
  **never a replay** (its outcome is unknown). Don't add retry-on-reconnect.
- **Socket safety**: `~/.bean` must be ours and not group/world-writable; the socket is born
  0600 (umask around `listen`); a symlink/non-socket is never unlinked, a live socket is never
  unlinked (connect probe), a dead one is. Frames cap at 1 MB, 8 connections, 8 calls in flight.
- **Delegates**: MCP runs use their **own** `createDelegateTasks` instance (chat-window close
  cancels only the chat instance) plus `mcp-runs.ts`, the in-memory registry (`delegate_status`,
  `list_delegates`, last 20 finished). Registry membership is the whole cancel scope — no
  fallback to pid/project/global lookup. `by: "agent"` only when the confirmed outcome is a
  cancel we asked for. Bean's UI has no Stop for these runs (by design).
- **Memory**: `remember` uses core `checkFact` (instruction/secret/project rejects, no quote
  check) — an MCP call has no typed provenance and must never claim it. Writes go through
  `buildMemoryHandlers().addToBatch`, which **merges** into the live Undo batch (a chat close
  still replaces it); batch transitions are serialized. `forget_memory` only takes ids that
  connection got from `recall_memories`.
- **Routines**: `run_routine` uses the scheduler's `startNow` (doesn't await) and records a
  `kind: "routine"` run whose outcome lands via `onFinish`; routines can't be cancelled.
