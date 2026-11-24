# main.log is the one raw-error log

`packages/app/src/main-log.ts` (#1092) tees the desktop main process's `console.error` /
`console.warn`, uncaught exceptions (monitor only — Electron's own handling is unchanged) and
unhandled rejections to `app.getPath("logs")/main.log` (`~/Library/Logs/Bean/main.log`), the same
file for local and remote cores. A `--user-data-dir` launch (e2e) writes `userData/logs/main.log`
instead, so tests never touch the real user's logs.

- **The only log allowed to hold raw error text** — message and stack, stderr tails, prompt or mail
  fragments. Every other log (`avatar.log`, …) stays allowlist-only; this is the stated exception
  to the "never in logs" rule in [convention-one-install-one-trust-domain](convention-one-install-one-trust-domain.md).
  Never send it off the Mac (no remote sink).
- Its guards are the price: 0600 file in a 0700 dir, each entry capped at 4 KB, one `.1` rotation
  at 5 MB (≈2× cap on disk), a write failure returns false and never re-enters the console.
- Bot servers' stderr reaches it as `console.error("[discord] …")` / `[teams]` from
  `chatops-servers.ts` (host). Under `bean-core` the same line goes to the service manager — no file.
