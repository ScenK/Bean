# convention: IPC channel names live in one place

All IPC channels are defined once as the `IPC` constant in
[`packages/app/src/channels.ts`](../packages/app/src/channels.ts) and imported by the main
process (`ipc.ts`), the preload (`preload.ts`), and the renderer.

When adding or renaming a channel, edit `channels.ts` and let all three sides import the
constant. **Never** hardcode a `"bean:..."` string literal in a handler or `ipcRenderer`
call — a typo on one side is a silent no-op that's painful to debug.

`route` is request/response (`ipcMain.handle` ↔ `ipcRenderer.invoke`). `launch` is one-way,
fire-and-forget (`ipcMain.on` ↔ `ipcRenderer.send`) — Bean hands the run off to Terminal.app
and doesn't track it further; see `convention-launch-hands-off-to-terminal.md`.
