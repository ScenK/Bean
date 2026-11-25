# safety: browser access only from skill frontmatter; `FAILED:` first line fails the run

**Browser.** A skill with `browser: true` frontmatter (`Skill.browser`) makes a delegate run
pass `DelegateRequest.browser`. `delegateCommand()` maps it: claude `--chrome`, else
`--no-chrome` (headless claude 2.1.287 loads Claude in Chrome only with the flag; the explicit
`--no-chrome` guards against a future default); codex unchanged (its `cua_repl` plugin already
gives browser + computer on every run); agy unchanged (its browser tools are always on); opencode is refused in `runDelegate()` **before spawn**
(synchronous `onError`, no timer, no `liveKills` entry). Combined with the permission bypass this
hands an unattended agent the user's logged-in sessions, so:

- Only the skill file can turn it on, re-resolved at launch in host/core — routines from the
  step's `Skill`, chatops `startRun` from its re-loaded skill, desktop via
  `DelegateStartRequest.skillName` → the host's `skillBrowser()` (`host.ts`). Never infer it from instruction
  text and never accept a renderer-, card-, or model-supplied boolean.
- The built-in `browser-read` skill (`.bean/skills/`, `quick-launch: false`) is the ready-made
  one: the sprout drafter (`propose_routine`) points pages that block bots or need JavaScript at
  a delegate step using it (#1107). Chat steps never get a browser — Bean's own model stays an
  API call; don't add a chat-step browser flag.
- Terminal launches and the routine builder deliberately don't get `--chrome`. Claude **live
  sessions always do** (#597, every surface) — they're steered turn by turn, so a `browser: true`
  skill sent into one must find the browser; see project-live-sessions for the war-room exposure.
- Skill proposal cards (desktop `SkillCard`, Discord/Teams `skillProposalCard`) disclose the
  change before Save via `skillBrowserChange(body, existing.browser)` in `frontmatter.ts`: "on"
  while the parsed body has `browser: true`, "off" when it drops it from an existing (incl.
  built-in/disabled) browser skill (#1108). Same frontmatter rule, never model prose.

**FAILED: sentinel.** A headless run that couldn't do its job still exits 0. Every delegate
prompt ends with `FAILED_SENTINEL_INSTRUCTION`; on exit 0, a final result whose first line
(CRLF-safe) starts with `FAILED:` goes to `onError(reason)` instead of `onDone`, checked
before the resume notice is prepended and never retried (a post may already have gone out).
`FAILED:` anywhere else is ordinary text; no sentinel = success. Callers need no change — a
rejected delegate is already a failed routine step / todo / chat card.

Sprout **chat steps** share the contract (#1107): `runChatStep`'s system prompt carries the
sentinel and the runner checks `failedReason()` (`agent-rules.ts`) on the final answer before
`session.finish()` and route/verdict parsing, so a blocked source fails the run (delivered even
with "only on problems") instead of taking the quiet route. A chat step that runs out of tool
rounds fails too — its intermediate text is never passed off as a report. Live sessions stay
without the sentinel.
