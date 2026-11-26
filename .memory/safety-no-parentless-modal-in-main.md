# No parentless modal dialogs on main's background paths

On macOS, `dialog.showMessageBox` **without a parent window** is app-modal even in its async
form: it runs a nested modal loop that freezes Electron's main process until someone dismisses
it. Delegate streaming, live sessions, IPC and quit all stall, and `app.evaluate` never returns.
(`showErrorBox` always blocks.)

- A path that runs unattended (recovery, background work, anything a test can hit) reports
  through a `Notification` or the log, never a parentless dialog. Bring Bean Back's failure
  notice was a dialog and wedged the app (#1121).
- E2E signature: a bare `Test timeout` **plus** `Worker teardown timeout` (`app.close()` hangs
  too). When you see both, look for a modal opened by main.
