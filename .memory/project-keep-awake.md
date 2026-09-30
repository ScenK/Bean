# Keep the Mac awake (#188)

`packages/app/src/keep-awake.ts` owns at most one `powerSaveBlocker("prevent-app-suspension")` id:
held while any `delegate`/`routine` task-status job is `running` (reconciled in `createTaskStatus`'s
send callback, *before* the avatar-destroyed check), or always when the tray's **Keep Mac Awake**
is checked (`userData/keep-awake.json`). Display may sleep; lid-closed is out of scope; no quit hook
(the IOKit assertion dies with the process).

- **Never add a wake verb to `system_control` or any model tool** — it also runs in the Discord/Teams
  bots, so a remote user or prompt injection could pin the Mac awake. Tray click / local file only.
- Every streamed delegate line re-sends the job list; the controller's no-op-on-same-state check is
  what keeps `start()` from leaking blocker ids. Don't "simplify" it away.
