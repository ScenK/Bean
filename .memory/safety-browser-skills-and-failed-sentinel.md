# safety: browser access only from skill frontmatter; `FAILED:` first line fails the run

**Browser.** A skill with `browser: true` frontmatter (`Skill.browser`) makes a delegate run
pass `DelegateRequest.browser`. `delegateCommand()` maps it: claude `--chrome`, else
`--no-chrome` (headless claude 2.1.287 loads Claude in Chrome only with the flag; the explicit
`--no-chrome` guards against a future default); codex unchanged (its `cua_repl` plugin already
gives browser + computer on every run); opencode is refused in `runDelegate()` **before spawn**
(synchronous `onError`, no timer, no `liveKills` entry). Combined with the permission bypass this
hands an unattended agent the user's logged-in sessions, so:

- Only the skill file can turn it on, re-resolved at launch in main/core — routines from the
  step's `Skill`, chatops `startRun` from its re-loaded skill, desktop via
  `DelegateStartRequest.skillName` → main's `skillBrowser()`. Never infer it from instruction
  text and never accept a renderer-, card-, or model-supplied boolean.
- Live sessions, terminal launches and the routine builder deliberately don't get `--chrome`.

**FAILED: sentinel.** A headless run that couldn't do its job still exits 0. Every delegate
prompt ends with `FAILED_SENTINEL_INSTRUCTION`; on exit 0, a final result whose first line
(CRLF-safe) starts with `FAILED:` goes to `onError(reason)` instead of `onDone`, checked
before the resume notice is prepended and never retried (a post may already have gone out).
`FAILED:` anywhere else is ordinary text; no sentinel = success. Callers need no change — a
rejected delegate is already a failed routine step / todo / chat card.
