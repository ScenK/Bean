# Keep the Mac awake (#188)

`packages/app/src/keep-awake.ts` owns at most one id per blocker type. **System**
(`prevent-app-suspension`): held while any `delegate`/`routine` task-status job is `running`
(reconciled in `createTaskStatus`'s send callback, *before* the avatar-destroyed check), or always
when the tray's **Keep Mac Awake** is checked. **Display** (`prevent-display-sleep`, #202): held only
while Keep Mac Awake *and* **Keep Display On** are checked — work never holds the display. Both flags
live in `userData/keep-awake.json` (`{ alwaysOn, display }`); the display flag is remembered while
Keep Mac Awake is off (row greyed). Each type is started/stopped and error-caught independently, so
dropping the display never drops a job's system hold. Lid-closed is out of scope; no quit hook (the
IOKit assertions die with the process).

- **Never add a wake verb to `system_control` or any model tool** — it also runs in the Discord/Teams
  bots, so a remote user or prompt injection could pin the Mac (or its unlocked display) awake. Tray click / local file only.
- Every streamed delegate line re-sends the job list; the controller's no-op-on-same-state check is
  what keeps `start()` from leaking blocker ids. Don't "simplify" it away.
