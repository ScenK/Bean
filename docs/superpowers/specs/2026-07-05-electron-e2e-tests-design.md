# Electron E2E tests — design

## Context

Bean already has CI (`.github/workflows/ci.yml`) running `pnpm test && pnpm typecheck` (vitest,
unit-level) on every push/PR, plus a release job (`mac-installer.yml`). `AGENTS.md` currently
says "There is no CI yet" — that line is stale and should be corrected as part of this change.

What's missing is any test that drives the actual packaged Electron app: window creation, the
preload IPC bridge (`window.bean`), and renderer flows (chat, proposals, opening component
windows). This spec adds that layer without touching production source.

## Goals

- Launch the real built app (`dist/main.js`) in CI and assert it doesn't crash.
- Drive real user-facing flows (chat send/receive, a proposal card, opening component windows)
  through the real IPC bridge — not mocked at the module level.
- Never call out to the real OpenAI API or spawn Terminal.app/CLI processes during tests.
- Zero changes to `@bean/core` or `@bean/app` source. Isolation is achieved entirely through
  environment variables the app already respects.

## Non-goals

- Testing the actual Terminal.app/`opencode`/`claude` process launch (`launchInTerminal`) —
  covered by existing unit tests (`launcher.test.ts`); E2E stops at the IPC call boundary.
- Testing `dist:mac` packaging/signing — covered by `mac-installer.yml`.
- Native drag-and-drop interactions (OS-level DnD is not reliably scriptable in CI).
- Lint/coverage tooling — out of scope for this pass.

## Design

### Tooling & layout

- New devDependency: `@playwright/test` in `packages/app` (Playwright's `_electron` API is the
  standard way to drive a real Electron app; no `spectron`, no custom launcher).
- New directory `packages/app/e2e/` with its own `playwright.config.ts`, separate from the
  existing vitest `__test__/` unit suite.
- New script in `packages/app/package.json`: `"test:e2e": "playwright test"`.
- E2E runs against the **built** app, so `pnpm build` must run before `test:e2e` (both locally
  and in CI).

### Isolation & fixtures

No source changes are needed because two things the app already does make it fully
env-var-sandboxable:

- `beanDir()` (`packages/core/src/config.ts`) is `join(homedir(), ".bean")`, and `homedir()`
  respects `$HOME`.
- The installed `openai` SDK (v6.45.0) falls back to `process.env.OPENAI_BASE_URL` for its
  base URL whenever the client is constructed with just an `apiKey` (which is what
  `makeOpenAIChat`/`makeOpenAIConverse` do) — confirmed by reading
  `node_modules/openai/client.js`.

So each E2E test file:

1. `mkdtemp()`s a temp directory, writes into it:
   - `.bean/config.json` — fake `openaiApiKey` (any non-empty string), `model: "gpt-4o-mini"`.
   - `.bean/projects.json` — one fixture project pointing at a throwaway temp folder.
   - `.bean/skills/*.md` — one or two minimal fixture skills (enough for `propose_run` to have
     something to select).
2. Starts a stub HTTP server (Node's built-in `http`, no new dependency) that answers
   `POST /v1/chat/completions` with canned JSON: plain `content` for ordinary replies, or a
   `tool_calls` payload shaped to trigger `propose_run`/`propose_note`/`propose_delegate` for the
   proposal-flow tests.
3. Launches the app via `_electron.launch({ args: ["dist/main.js"], env: { ...process.env, HOME:
   tmpHome, OPENAI_BASE_URL: stubServerUrl } })`.
4. On teardown: closes the Electron app, stops the stub server, removes the temp dir.

### Flows covered

| Test | Drives | Asserts |
|---|---|---|
| Smoke | Launch app | Avatar `BrowserWindow` opens, `window.bean` bridge exists, no crash/console error |
| Chat | `window.bean.openComponent("chat")`; real DOM type + send in the chat window | Stubbed reply renders in the transcript |
| Proposal (in-chat) | Stub returns a `propose_run` tool call; confirm the resulting `ProposalCard` | Card shows the skill name; confirming an in-chat-target proposal sends the prompt in-chat |
| Launch boundary | Same, but proposal targets `terminal`/`opencode` | Before clicking confirm, override `window.bean.launch` in-page with a spy; assert it's called with the expected `{mode, projectPath, prompt}` — verifies wiring without spawning a real process |
| Component windows | Call `window.bean.openComponent(kind)` for `skills`, `projects`, `settings` | Each opens a new window and renders its expected root content with no console errors |

(Opening windows is driven directly via `window.bean.openComponent()` rather than simulating
the avatar's petal-menu click: that petal UI already has its own geometry/state-machine unit
tests (`avatar-menu.test.ts`), and its window-resize IPC round trip is unrelated flakiness this
suite doesn't need to take on to cover the chat/proposal/window-opening value described above.)

### CI wiring

- New job `e2e` added directly to `.github/workflows/ci.yml`, alongside the existing `test`
  job, same triggers (`push: [main]`, `pull_request`) — runs automatically on every commit.
  This repo is public, so macOS Actions minutes are free (no per-minute multiplier cost
  concern), which is what makes running it on every push/PR the right default rather than a
  manual/opt-in step.
- Runs on `macos-latest`, not `ubuntu-latest`: `packages/app/src/main.ts` calls the macOS-only
  `nativeImage.createMenuSymbol()` unconditionally at startup (tray menu icons) — its behavior
  on Linux is undocumented/unverified, so a Linux runner risks the whole app failing to boot
  before any covered flow even runs. macOS also matches Bean's actual (macOS-only) production
  platform and needs no `xvfb`:
  ```yaml
  - pnpm install --frozen-lockfile
  - pnpm build
  - pnpm --filter @bean/app run test:e2e
  ```
- Separate job (not appended to the existing `test` job) so a flaky/slower e2e run doesn't
  hold up the fast unit-test signal.
- Not added to any branch-protection required-checks list — visible (✅/❌ on every PR) but
  advisory, so an occasional flake never hard-blocks an otherwise-good merge. This is
  independent of the cost question above.
- `mac-installer.yml` is unchanged — it already runs `pnpm test && pnpm typecheck` before
  packaging; e2e is not added there to keep release builds fast.

### Documentation fix

- Correct the stale "There is no CI yet — local green is the only safety net." line in
  `AGENTS.md` to reflect that CI exists (`ci.yml`, `mac-installer.yml`) and now includes an
  `e2e` job.

## Testing

This feature *is* a test suite; its own correctness check is: run `pnpm --filter @bean/app
test:e2e` locally and confirm all 5 flows above pass, then confirm the new `e2e` CI job goes
green on a real PR.

## Open questions / risks

- Playwright's Electron support assumes a Chromium-based renderer, which Bean's is — no known
  blocker, but this is the first time Playwright is introduced to the repo, so the plan should
  budget time for CI flakiness shakeout (headless/xvfb timing issues are the most common
  failure mode for Electron E2E in CI).
- Per-test vs. per-file temp `HOME`/stub-server lifecycle is left to the implementation plan —
  per-file is simpler and likely sufficient given the small number of flows.
