# Electron E2E Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright-driven E2E suite that boots the real built Bean Electron app and exercises the chat flow, proposal cards, and component windows through the real `window.bean` IPC bridge — with zero production source changes.

**Architecture:** Playwright's `_electron` API launches `packages/app/dist/main.js` with `HOME` pointed at a throwaway temp directory (so it gets its own `~/.bean`) and `OPENAI_BASE_URL` pointed at a tiny in-process stub HTTP server (so no real OpenAI calls happen). Tests drive the real preload bridge via `page.evaluate()` and real DOM interactions, never mocking modules.

**Tech Stack:** `@playwright/test` (new devDependency, `packages/app` only), Node's built-in `http` for the stub server, the app's existing built output (`pnpm build` must run first).

## Global Constraints

- Zero changes to `@bean/core` or `@bean/app` production source (`src/`) — isolation is achieved entirely via env vars (`HOME`, `OPENAI_BASE_URL`) the app already respects.
- E2E test files live in `packages/app/e2e/`, separate from the existing vitest suite in `packages/app/__test__/`.
- E2E spec files are named `*.e2e.ts` (not `*.test.ts`/`*.spec.ts`) so vitest's default include glob never picks them up — no vitest config changes needed.
- E2E files are NOT part of `packages/app/tsconfig.json`'s `include` — they are not type-checked by `pnpm typecheck`; Playwright compiles its own `.ts` test files on the fly.
- Never call the real OpenAI API or spawn a real Terminal.app/CLI process from a test.
- CI: new `e2e` job added directly to the existing `.github/workflows/ci.yml`, same triggers as
  the `test` job (`push: [main]` + every `pull_request`) — runs automatically on every commit.
  This repo is public, so macOS Actions minutes are free; that's what makes "every push/PR" the
  right default instead of a manual/opt-in step. Never added to a branch-protection required-
  checks list, so an occasional flake is visible (✅/❌ on the PR) but never hard-blocks a merge.
- Reuse the repo's own built-in skills (`.bean/skills/draft-reply.md` — `target: chat`, and `.bean/skills/review-pr.md` — `target: terminal`) as fixtures instead of writing new fixture skill files — `main.ts` already layers these in via `projectBeanDir()` regardless of `HOME`.

---

### Task 1: Playwright scaffolding + fixture harness + smoke test

**Files:**
- Create: `packages/app/playwright.config.ts`
- Create: `packages/app/e2e/fixtures/bean-home.ts`
- Create: `packages/app/e2e/fixtures/stub-openai.ts`
- Create: `packages/app/e2e/fixtures/launch-app.ts`
- Create: `packages/app/e2e/smoke.e2e.ts`
- Modify: `packages/app/package.json` (add `@playwright/test` devDependency + `test:e2e` script)
- Modify: `.gitignore` (add Playwright output dirs)

**Interfaces:**
- Produces (used by every later task):
  - `makeBeanHome(): Promise<{ homeDir: string; projectPath: string; cleanup: () => Promise<void> }>` from `e2e/fixtures/bean-home.ts`
  - `startStubOpenAI(): Promise<{ url: string; queue: (reply: { content?: string; toolCall?: { name: string; args: Record<string, unknown> } }) => void; close: () => Promise<void> }>` from `e2e/fixtures/stub-openai.ts`
  - `launchBean(env: Record<string, string>): Promise<ElectronApplication>` from `e2e/fixtures/launch-app.ts`

- [ ] **Step 1: Add the Playwright devDependency**

Run: `pnpm add -D @playwright/test --filter @bean/app`
Expected: `packages/app/package.json` gains `"@playwright/test"` under `devDependencies`, `pnpm-lock.yaml` updates.

- [ ] **Step 2: Add the `test:e2e` script**

Edit `packages/app/package.json`, in the `"scripts"` block, add a `test:e2e` entry next to the existing `"test"` entry:

```json
    "test": "vitest run",
    "test:e2e": "playwright test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
```

- [ ] **Step 3: Write the Playwright config**

Create `packages/app/playwright.config.ts`:

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  reporter: "list",
});
```

- [ ] **Step 4: Run the (empty) suite to confirm it fails for the right reason**

Run: `pnpm --filter @bean/app run test:e2e`
Expected: FAIL — `smoke.e2e.ts` doesn't exist yet, so Playwright reports "no tests found" (or a module-not-found error once Step 8 adds a spec importing not-yet-created fixtures). This confirms the config loads and Playwright is wired up before any real code exists.

- [ ] **Step 5: Write the bean-home fixture**

Create `packages/app/e2e/fixtures/bean-home.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BeanHome {
  homeDir: string;
  projectPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a throwaway `~/.bean` fixture: a fake config + one fixture project. No skill fixture
 * files are needed — main.ts also layers in the repo's own `.bean/skills/*.md` as "builtin"
 * skills regardless of HOME, and those already include both a `target: chat` skill
 * (draft-reply) and a `target: terminal` skill (review-pr) for the proposal-flow tests.
 */
export async function makeBeanHome(): Promise<BeanHome> {
  const homeDir = await mkdtemp(join(tmpdir(), "bean-e2e-home-"));
  const projectPath = await mkdtemp(join(tmpdir(), "bean-e2e-project-"));
  const beanDir = join(homeDir, ".bean");
  await mkdir(beanDir, { recursive: true });
  await writeFile(
    join(beanDir, "config.json"),
    JSON.stringify({ openaiApiKey: "sk-test-fixture", model: "gpt-4o-mini" }, null, 2),
    "utf8",
  );
  await writeFile(
    join(beanDir, "projects.json"),
    JSON.stringify([{ name: "demo", path: projectPath }], null, 2),
    "utf8",
  );
  return {
    homeDir,
    projectPath,
    cleanup: async () => {
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectPath, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 6: Write the stub OpenAI server**

Create `packages/app/e2e/fixtures/stub-openai.ts`:

```typescript
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubReply {
  content?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

export interface StubOpenAI {
  url: string;
  /** Queues one canned response; each `/v1/chat/completions` request consumes the next queued
   * reply, FIFO. Queue exactly as many replies as requests the test will trigger — an
   * under-queued request gets a safe empty-content fallback rather than hanging. */
  queue: (reply: StubReply) => void;
  close: () => Promise<void>;
}

/**
 * A minimal stand-in for `POST /v1/chat/completions` — just enough of the OpenAI response
 * shape that `makeOpenAIConverseWithClient` (packages/core/src/openai-chat.ts) reads:
 * `choices[0].message.content` and, for tool calls, `choices[0].message.tool_calls[].function`.
 */
export async function startStubOpenAI(): Promise<StubOpenAI> {
  const replies: StubReply[] = [];
  const server: Server = createServer((req, res) => {
    req.resume(); // drain the request body so 'end' fires; we don't need its contents
    req.on("end", () => {
      const reply = replies.shift();
      const message: Record<string, unknown> = { content: reply?.content ?? "" };
      if (reply?.toolCall) {
        message.tool_calls = [
          { function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } },
        ];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    queue: (reply) => replies.push(reply),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 7: Write the app launcher**

Create `packages/app/e2e/fixtures/launch-app.ts`:

```typescript
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/e2e/fixtures
const appRoot = join(here, "..", ".."); // packages/app
const mainJs = join(appRoot, "dist", "main.js");

/** Launches the real built Bean app. `env` typically supplies HOME (sandboxed ~/.bean) and
 * OPENAI_BASE_URL (stub server) — see bean-home.ts and stub-openai.ts. */
export async function launchBean(env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainJs],
    cwd: appRoot,
    env: { ...process.env, ...env },
  });
}
```

- [ ] **Step 8: Write the smoke test**

Create `packages/app/e2e/smoke.e2e.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("app boots: avatar window opens with the window.bean IPC bridge", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    await expect
      .poll(() => avatar.evaluate(() => typeof (window as unknown as { bean?: unknown }).bean))
      .toBe("object");
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
```

- [ ] **Step 9: Build the app, then run the smoke test**

Run: `pnpm build && pnpm --filter @bean/app run test:e2e`
Expected: PASS — 1 test passed. (`pnpm build` is required first: the launcher points at `dist/main.js`, and E2E always runs against the built app, never source.)

- [ ] **Step 10: Ignore Playwright's output directories**

Edit `.gitignore`, add after the existing entries:

```
/.superpowers/
/.worktrees/
/packages/app/test-results/
/packages/app/playwright-report/
```

- [ ] **Step 11: Commit**

```bash
git add packages/app/playwright.config.ts packages/app/e2e packages/app/package.json pnpm-lock.yaml .gitignore
git commit -m "test(e2e): add Playwright Electron harness + smoke test"
```

---

### Task 2: Chat flow test

**Files:**
- Create: `packages/app/e2e/chat.e2e.ts`

**Interfaces:**
- Consumes: `makeBeanHome`, `startStubOpenAI`, `launchBean` (Task 1)

- [ ] **Step 1: Write the failing test**

Create `packages/app/e2e/chat.e2e.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("chat: sending a message renders the stubbed reply", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({ content: "Hello from stub!" });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.waitForLoadState("domcontentloaded");
    await chat.locator(".bean-input--composer").fill("hi bean");
    await chat.locator(".bean-send").click();
    await expect(chat.locator(".bean-bubble--bean")).toContainText("Hello from stub!");
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
```

This test needs no new implementation — it's exercised entirely through Task 1's fixtures and the app's own existing code. "Failing" here means: run it before confirming the selectors are right.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @bean/app run test:e2e -- chat.e2e.ts`
Expected: PASS. If it fails on a selector (e.g. `.bean-input--composer` not found), re-check `packages/app/src/renderer/components/chat/ChatPanel.tsx` for the current class names before changing the test.

- [ ] **Step 3: Commit**

```bash
git add packages/app/e2e/chat.e2e.ts
git commit -m "test(e2e): add chat send/receive flow"
```

---

### Task 3: Proposal (in-chat target) flow test

**Files:**
- Create: `packages/app/e2e/proposal-in-chat.e2e.ts`

**Interfaces:**
- Consumes: `makeBeanHome`, `startStubOpenAI`, `launchBean` (Task 1); the repo's own `.bean/skills/draft-reply.md` (`target: chat`) as the fixture skill.

- [ ] **Step 1: Write the test**

Create `packages/app/e2e/proposal-in-chat.e2e.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("proposal (in-chat target): confirming sends the composed prompt in chat", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  // First request: the model proposes running the "draft-reply" skill (target: chat).
  stub.queue({
    toolCall: { name: "propose_run", args: { skill: "draft-reply", project: home.projectPath, instruction: "reply to Jane" } },
  });
  // Second request: the follow-up send triggered by confirming an in-chat proposal.
  stub.queue({ content: "Here's a draft reply to Jane." });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.locator(".bean-input--composer").fill("draft a reply to Jane");
    await chat.locator(".bean-send").click();

    const card = chat.locator(".bean-card");
    await expect(card).toContainText("draft-reply");
    await card.locator(".bean-btn").first().click(); // "Confirm & run"

    await expect(chat.locator(".bean-status")).toContainText("Running here");
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("Here's a draft reply to Jane.");
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @bean/app run test:e2e -- proposal-in-chat.e2e.ts`
Expected: PASS. If the card's chip text or status text differs from what's asserted, check the current text in `packages/app/src/renderer/shared/ProposalCard.tsx` (chip: `skill · {run.skillName}`) and `packages/app/src/renderer/components/chat/ChatWindow.tsx`'s `confirmProposal` (status: `"Running here…"`).

- [ ] **Step 3: Commit**

```bash
git add packages/app/e2e/proposal-in-chat.e2e.ts
git commit -m "test(e2e): add in-chat proposal confirm flow"
```

---

### Task 4: Proposal (terminal target) launch-boundary test

**Files:**
- Create: `packages/app/e2e/proposal-launch-boundary.e2e.ts`

**Interfaces:**
- Consumes: `makeBeanHome`, `startStubOpenAI`, `launchBean` (Task 1); the repo's own `.bean/skills/review-pr.md` (`target: terminal`) as the fixture skill.

- [ ] **Step 1: Write the test**

Create `packages/app/e2e/proposal-launch-boundary.e2e.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("proposal (terminal target): confirming calls window.bean.launch, never a real process", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  stub.queue({
    toolCall: { name: "propose_run", args: { skill: "review-pr", project: home.projectPath, instruction: "review PR 1" } },
  });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]);
    await chat.locator(".bean-input--composer").fill("review PR 1");
    await chat.locator(".bean-send").click();

    const card = chat.locator(".bean-card");
    await expect(card).toContainText("review-pr");

    // Spy on window.bean.launch before confirming — proves the click reaches the IPC
    // boundary with the right payload without ever spawning Terminal.app/opencode for real.
    await chat.evaluate(() => {
      (window as unknown as { __lastLaunch?: unknown }).__lastLaunch = undefined;
      (window as unknown as { bean: { launch: (req: unknown) => void } }).bean.launch = (req: unknown) => {
        (window as unknown as { __lastLaunch?: unknown }).__lastLaunch = req;
      };
    });
    await card.locator(".bean-btn").first().click(); // "Confirm & run"

    const launchReq = await chat.evaluate(() => (window as unknown as { __lastLaunch?: unknown }).__lastLaunch);
    expect(launchReq).toMatchObject({ mode: "opencode", projectPath: home.projectPath });
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @bean/app run test:e2e -- proposal-launch-boundary.e2e.ts`
Expected: PASS. If `launchReq` doesn't match, check `confirmProposal` in `packages/app/src/renderer/components/chat/ChatWindow.tsx` for the current `window.bean.launch({...})` call shape.

- [ ] **Step 3: Commit**

```bash
git add packages/app/e2e/proposal-launch-boundary.e2e.ts
git commit -m "test(e2e): add terminal-target proposal launch-boundary flow"
```

---

### Task 5: Component windows test

**Files:**
- Create: `packages/app/e2e/component-windows.e2e.ts`

**Interfaces:**
- Consumes: `makeBeanHome`, `startStubOpenAI`, `launchBean` (Task 1)

- [ ] **Step 1: Write the test**

Create `packages/app/e2e/component-windows.e2e.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

test("component windows: skills, projects, settings open and render their fixture data", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const open = (kind: string) =>
      Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate(
          (k) => (window as unknown as { bean: { openComponent: (kind: string) => void } }).bean.openComponent(k),
          kind,
        ),
      ]).then(([win]) => win);

    const skills = await open("skills");
    await expect(skills.locator(".bean-skills-row-name", { hasText: "draft-reply" })).toBeVisible();

    const projects = await open("projects");
    await expect(projects.locator(".bean-projects-name", { hasText: "demo" })).toBeVisible();

    const settings = await open("settings");
    await expect(settings.locator('input[placeholder="sk-…"]')).toBeVisible();
  } finally {
    await app.close();
    await stub.close();
    await home.cleanup();
  }
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @bean/app run test:e2e -- component-windows.e2e.ts`
Expected: PASS.

- [ ] **Step 3: Run the full e2e suite together**

Run: `pnpm build && pnpm --filter @bean/app run test:e2e`
Expected: PASS — all 5 specs (smoke, chat, proposal-in-chat, proposal-launch-boundary, component-windows) green.

- [ ] **Step 4: Commit**

```bash
git add packages/app/e2e/component-windows.e2e.ts
git commit -m "test(e2e): add component window open/render flow"
```

---

### Task 6: CI wiring + docs fix

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`

**Interfaces:** none (final integration task).

- [ ] **Step 1: Add the `e2e` job to the existing CI workflow**

Edit `.github/workflows/ci.yml`, adding a new `e2e` job after the existing `test` job (same
file, same triggers already declared at the top — no changes needed there):

```yaml
  e2e:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm --filter @bean/app run test:e2e
```

The full file should read:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test && pnpm typecheck

  e2e:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm --filter @bean/app run test:e2e
```

Notes captured here for the implementer, not the workflow file itself:
- Same triggers as `test` (`push: [main]` + every `pull_request`) — runs automatically on
  every commit. This repo is public, so macOS Actions minutes are free, which is what makes
  "every push/PR" the right default instead of a manual/opt-in step.
- `macos-latest`, not `ubuntu-latest`: `packages/app/src/main.ts` calls the macOS-only
  `nativeImage.createMenuSymbol()` unconditionally at startup to build the tray menu —
  behavior on Linux is undocumented/unverified, so macOS avoids that risk entirely and matches
  Bean's actual (macOS-only) production platform. No `xvfb` needed as a result.
- Separate job from `test`, not merged into it, so a flaky/slower e2e run doesn't hold up the
  fast unit-test signal.
- Do not add this job to any branch-protection required-checks list — it's intentionally
  visible (✅/❌ on every PR) but advisory, so an occasional flake never hard-blocks an
  otherwise-good merge.

- [ ] **Step 2: Verify the workflow YAML is well-formed**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" 2>/dev/null || node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"`
Expected: no output / no error. If neither `yaml` module is available locally, visually check
the indentation matches the `test` job's style (2-space, `steps:` list under each job key).

- [ ] **Step 3: Fix the stale AGENTS.md CI claim**

In `AGENTS.md`, find this text under "## Environment & Commands":

```
**Validation gate:** run `pnpm test && pnpm typecheck` and confirm both exit 0 before
claiming work is done. There is no CI yet — local green is the only safety net.
```

Replace it with:

```
**Validation gate:** run `pnpm test && pnpm typecheck` and confirm both exit 0 before
claiming work is done. CI (`.github/workflows/ci.yml`) runs the same two commands on every
push to `main` and every PR, plus an `e2e` job (Playwright driving the real built Electron
app — see `packages/app/e2e/`) on `macos-latest`. The `e2e` job is advisory, not a required
check, so an occasional flake never blocks a merge — but check its result before merging a PR
that touches app boot, IPC, or window behavior.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml AGENTS.md
git commit -m "ci: add e2e job (macos-latest) to CI; fix stale AGENTS.md CI note"
```

- [ ] **Step 5: Push and confirm the job actually runs green in CI**

Push this branch and open a PR (or push directly if working on `main`), then check:
`gh run list --workflow=ci.yml --limit 1` and `gh run watch <run-id>`
Expected: both `test` and `e2e` jobs report `success`.
