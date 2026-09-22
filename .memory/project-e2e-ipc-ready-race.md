# Resolved: avatar renderer must load after IPC registration

The avatar previously loaded as soon as its BrowserWindow was created, before async startup
completed and `registerIpc()` ran. Its first `getTheme()` or `openComponent()` could fail with
"No handler registered". Missing theme variables removed the SVG fill/glow and left a
transparent capsule with a black border on hover.

`createAvatarWindow()` now creates a hidden, unloaded window. Main calls
`loadAvatarWindow()` only after IPC is registered; loading completes before showing it.
The avatar HTML also supplies a theme fallback, and a failed theme request keeps that fallback.
Do not restore eager loading or move renderer startup ahead of handler registration.
Unrecoverable startup/load errors show an error and quit through normal cleanup rather than
leaving an invisible running instance; errors after a successful avatar load remain non-fatal.

Keep Playwright `workers: 1`: independent Electron launches can still contend. The startup
ordering fix alone is not evidence that parallel desktop tests are safe.
