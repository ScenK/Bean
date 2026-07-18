# Live Sessions — Chat-Bridged Interactive Coding Agent

**Date:** 2026-07-18
**Status:** Approved design, pre-implementation

## Problem

Bean today offers three run shapes, none of which supports a remote, multi-turn,
interactive coding-agent session:

- **Launcher** (`launcher.ts`) — headed Terminal.app session, fire-and-forget. Requires
  sitting at the desk.
- **Delegate** (`delegate.ts`) — headless single-shot `claude -p` / `opencode run`.
  Streamed and cancellable, but one round only: no follow-up turns, no steering.
- **Chatops** (Discord/Teams) — multi-turn conversation with Bean itself, but Bean's
  `converse()` model, not a coding agent working a repo.

Target use case (war-room): during an incident, colleagues gather in a group chat.
Someone launches a real-time coding agent against a project on the host Mac. Everyone
in the channel sees the agent's output live and anyone can post hints that steer the
next turn. The full investigation transcript stays in channel history for the
postmortem.

A web-terminal approach (PTY + xterm.js + Tailscale URL) was considered and rejected
for this use case: every viewer would need tailnet access provisioned mid-incident, a
shared PTY has a one-keyboard problem, and the session transcript evaporates when the
terminal closes. Chat is already a turn-taking protocol with free visibility and
history. A web-terminal mode may return later as a solo-mode add-on; it is out of
scope here.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Interaction shape | Chat-turn bridge in chatops (not web terminal) |
| Agent CLI | Claude Code first; provider interface leaves seam for opencode later |
| Surface | Discord first; bridge lives in shared `chatops/` so Teams follows nearly free |
| Permissions | Full auto (`--dangerously-skip-permissions`); launch stays confirm-first; feature gated behind opt-in config flag |
| Steering | Anyone in the bound channel can post turns |

## User flow

1. In a Discord channel (or DM): "Bean, start a live coding session on project X,
   dig into this stack trace…"
2. `converse()` proposes a live session via a new tool `propose_live_session`
   (provider, model, project, initial instruction). Rendered as a confirm-first card —
   existing proposal-card pattern.
3. On confirm, the bot server spawns a long-lived Claude Code process on the Mac and
   binds the session to the channel.
4. Agent output streams into the channel: one message, progressively edited
   (~1.5 s throttle), rolling over to a new message near the 2000-char limit. Each
   completed turn gets a footer (duration, cost).
5. Any message posted in the channel while the session is active is routed to the
   agent's stdin as the next user turn. The whole channel sees everything.
6. A `stop` command or idle timeout (default 30 min) ends the session; the channel
   reverts to normal `converse()` chat.

## Architecture

### Core: `packages/core/src/live-session.ts`

New module, pure and dependency-injected, zero Electron — sibling of `delegate.ts`.

```ts
interface LiveSessionProvider {
  start(opts: LiveSessionOptions): LiveSessionHandle; // spawn + first turn
}

interface LiveSessionHandle {
  send(text: string): void;   // write next user turn
  stop(): Promise<void>;      // kill process group
  // events: onOutput(chunk), onTurnComplete(summary), onExit(code)
}
```

**Claude provider (built now):** spawns
`claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions`
in the project directory. The process stays alive across turns; user turns are written
as JSON lines to stdin; assistant/result events are parsed from stdout. Command
construction lives beside `delegateCommand()` in the same style.

**Opencode provider (later, not built now):** an HTTP client to `opencode serve`
implementing the same interface. The interface is the seam; no opencode code ships in
this iteration.

### Chatops: `packages/core/src/chatops/`

- **`LiveSessionProposalStore`** — a fifth one-shot claim store, same pattern as the
  existing four (run / note / memory / skill).
- **Session registry** — `channelId → active LiveSessionHandle`. The bot message
  handler checks the registry before the normal converse flow: an active session
  captures the channel's messages and routes them to `send()`. A `stop` keyword
  releases the binding.
- **Stream renderer** — buffers agent output and emits throttled, surface-agnostic
  "post or edit message" calls. The buffer is the source of truth; adapters render it.

### Surface: `packages/discord/`

Renders the live-session card and implements the edit-throttled message updates
against the Discord API. The bot server is standalone — the Electron app does not need
to be running. Teams gets the same behavior later by implementing the same adapter
calls; no core changes expected.

## Config & safety

- `~/.bean/config.json` gains `liveSessions: false` (default). The feature is
  invisible until opted in — same pattern as `systemControls`.
- Launch is always confirm-first via the proposal card, even though the session itself
  runs with permissions bypassed.
- The working directory must be a registered project from `~/.bean/projects.json` —
  arbitrary paths from chat are rejected.
- Known accepted risk (explicitly chosen): full-auto permissions plus
  anyone-in-channel steering means anyone in a bound channel can drive a
  shell-capable agent on the host Mac. Mitigations are the opt-in flag, the
  confirm-first launch, and the registered-project constraint.

## Cost model

- Bean's own model (`converse()`) is only invoked at launch time to propose the
  session. During an active session the registry bypasses `converse()` entirely —
  marginal Bean-model cost is ~zero.
- The Claude Code session bills exactly as it would at the desk: covered by a Claude
  subscription if the CLI is authed that way, or per-token on an API key. Idle
  sessions cost nothing (no inference between turns); long multi-turn sessions grow
  context and cost more per turn — same as desk usage.

## Error handling

- Spawn failure → error message in the channel; registry entry cleared.
- Process crash mid-session → exit event posts "session died (code N)"; registry
  cleared; channel reverts to normal chat.
- Unparseable stdout lines are skipped (same policy as `delegate.ts`).
- Discord edit rate-limit errors → back off and retry on the next tick; output is
  never lost because the buffer is the source of truth.

## Testing

- **Core (`live-session.ts`):** fake child process (existing `delegate` test
  pattern) — multi-turn stdin writes, stream parsing, `stop()` kills the process
  group, idle timeout fires.
- **Chatops:** fake surface adapter — registry capture/release, throttle and
  rollover logic, one-shot card claim.
- **Manual smoke (validation gate):** real Discord server + real `claude` CLI on the
  Mac before claiming done, per AGENTS.md dev/compiled verification rules.

## Out of scope

- Opencode provider (seam only).
- Teams adapter (follows Discord).
- Web-terminal / PTY streaming mode (possible future solo-mode add-on).
- Per-action permission cards (rejected in favor of full auto).
