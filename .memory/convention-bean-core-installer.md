# bean-core installer: one script, links + restart

`packages/host/install.sh` (#836) ships at the top of `bean-core-<ver>.tar.gz` (`scripts/pack-bean-core.mjs`)
and owns the whole native lifecycle: install/upgrade, `--uninstall`, `--rollback`, and `--restart`
(used by `bean-core update` when no core was running — [convention-core-self-update.md](convention-core-self-update.md)).

- Versions live in `~/.local/share/bean-core/versions/<ver>/`; the LaunchAgent, the systemd unit and
  the `/usr/local/bin/bean-core` wrapper all run `current/…`, so upgrade and rollback are a symlink
  flip plus a restart — never rewrite the service file to switch versions.
- `bean-core rollback` is handled by the **wrapper** (it execs `current/install.sh --rollback`), not
  by `bean-core.js`; there is no rollback code in the bundle.
- Values written into the wrapper / plist / unit go through `safe` (no control characters) and the
  file's own escaper (`sh_quote`, `xml_escape`, `sd_quote`/`sd_raw`). Add a value → escape it the same way.
- `/bin/sh` is dash on Linux: keep the script POSIX. `__test__/install-sh.test.ts` runs it against
  stubbed `launchctl`/`systemctl`/`sudo`/`uname` with `BEAN_CORE_SYSROOT` (test-only prefix for the
  root-owned paths); real systemd was smoke-tested in a privileged `node:24-bookworm` container.
