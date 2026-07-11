# Discord Adapter + Chatops Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the transport-agnostic chat-bot brain from `@bean/teams` into `@bean/core` (`chatops/`), then add `@bean/discord` — a gateway-connected personal Discord adapter (guild @mentions + DMs, allowlist-only) reusing that brain.

**Architecture:** Part 1 moves `bot.ts` + four stores/helpers into `packages/core/src/chatops/` with one deliberate logic change: card builders become an injected `CardBuilders` dependency so the brain has zero presentation code. Part 2 builds `packages/discord/` — pure `discord-config`/`components`/`chunk` modules plus one impure `server.ts` wiring a discord.js v14 client onto the same `IncomingMessage`/`CardAction`/`BotEffects` interfaces.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), `discord.js` v14, vitest. Spec: `docs/superpowers/specs/2026-07-10-discord-adapter-design.md`.

## Global Constraints

- Work in the worktree `.worktrees/teams-bot` (branch `teams-bot`); run all commands from that root.
- ESM with `verbatimModuleSyntax`: `.js` extensions on relative imports; `import type` for type-only imports. `strict` + `noUncheckedIndexedAccess` are on.
- Kebab-case filenames. Pure DI'd logic in modules; impure wiring only in `server.ts` files.
- Model-memory keys stay literally `teams:cli` / `teams:model:<cli>` (persisted user state, intentionally shared across adapters).
- `buildTeamsBot` / `TeamsBotDeps` keep their names (rename is explicitly deferred).
- Import via `@bean/core`'s barrel from other packages, relative paths within core.
- Validation gate before claiming done: `pnpm test && pnpm typecheck` at the root, both exit 0.
- Commit messages end with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Move chatops into `@bean/core` + inject `CardBuilders`

**Files:**
- Move: `packages/teams/src/{bot,conversation,proposals,runs,resolve}.ts` → `packages/core/src/chatops/`
- Move: `packages/teams/__test__/{bot,conversation,proposals,runs,resolve}.test.ts` → `packages/core/__test__/chatops-<name>.test.ts`
- Create: `packages/core/src/chatops/cards-api.ts`
- Modify: `packages/core/src/index.ts` (re-export chatops), `packages/teams/src/cards.ts` (input types now imported), `packages/teams/src/server.ts` (imports + `cards` dep)

**Interfaces:**
- Consumes: existing core modules (`converse.js`, `models.js`, `launcher.js`, `delegate.js`, `types.js`, `persona.js`, `memory/memory.js`).
- Produces (all re-exported from `@bean/core`): everything the five files already export, plus from `cards-api.ts`:

```typescript
export interface ProposalCardInput {
  proposalId: string; projectName: string; skillName?: string; instruction: string;
  clis: CliName[]; models: AvailableModel[]; defaultCli: CliName; defaultModel?: string;
}
export interface RunningCardInput {
  projectName: string; instruction: string; startedBy: string; tail?: string; projectPath: string;
}
export interface FinishedCardInput {
  projectName: string; instruction: string; startedBy: string; outcome: "done" | "error" | "cancelled";
}
export interface CardBuilders {
  proposalCard: (input: ProposalCardInput) => object;
  runningCard: (input: RunningCardInput) => object;
  finishedCard: (input: FinishedCardInput) => object;
}
```

and `TeamsBotDeps` gains one field: `cards: CardBuilders;`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/core/src/chatops
git mv packages/teams/src/bot.ts packages/core/src/chatops/bot.ts
git mv packages/teams/src/conversation.ts packages/core/src/chatops/conversation.ts
git mv packages/teams/src/proposals.ts packages/core/src/chatops/proposals.ts
git mv packages/teams/src/runs.ts packages/core/src/chatops/runs.ts
git mv packages/teams/src/resolve.ts packages/core/src/chatops/resolve.ts
git mv packages/teams/__test__/bot.test.ts packages/core/__test__/chatops-bot.test.ts
git mv packages/teams/__test__/conversation.test.ts packages/core/__test__/chatops-conversation.test.ts
git mv packages/teams/__test__/proposals.test.ts packages/core/__test__/chatops-proposals.test.ts
git mv packages/teams/__test__/runs.test.ts packages/core/__test__/chatops-runs.test.ts
git mv packages/teams/__test__/resolve.test.ts packages/core/__test__/chatops-resolve.test.ts
```

- [ ] **Step 2: Rewrite imports in the moved src files (exact mapping)**

Chatops files live one level below `src/`, so former `"@bean/core"` imports become relative:

| Moved file | Old import | New import |
|---|---|---|
| `bot.ts` | `converse`, `type ConverseDeps` from `@bean/core` | `from "../converse.js"` |
| `bot.ts` | `availableModels` | `from "../models.js"` |
| `bot.ts` | `type Skill, type Project` | `from "../types.js"` |
| `bot.ts` | `type Persona` | `from "../persona.js"` |
| `bot.ts` | `type Memory` | `from "../memory/memory.js"` |
| `bot.ts` | `type CliName` | `from "../launcher.js"` |
| `bot.ts` | `type DelegateRequest` | `from "../delegate.js"` |
| `bot.ts` | `{ finishedCard, proposalCard, runningCard } from "./cards.js"` | **delete** (replaced by `deps.cards`, Step 3) |
| `conversation.ts` | `type ChatTurn` from `@bean/core` | `from "../converse.js"` |
| `proposals.ts` | `type CliName, type ProposedDelegate` | `from "../launcher.js"` / `from "../converse.js"` |
| `runs.ts` | `type DelegateCallbacks, type DelegateHandle, type DelegateRequest` | `from "../delegate.js"` |
| `resolve.ts` | `availableModels, pickModel` / `type CliName` | `from "../models.js"` / `from "../launcher.js"` |

Sibling imports (`"./resolve.js"`, `"./conversation.js"`, `"./proposals.js"`, `"./runs.js"`) are unchanged.

- [ ] **Step 3: Create `cards-api.ts` and inject it into `bot.ts`**

`packages/core/src/chatops/cards-api.ts` — exactly the interfaces from the Produces block above, with:

```typescript
import type { CliName } from "../launcher.js";
import type { AvailableModel } from "../models.js";
```

In `chatops/bot.ts`:
- add `import type { CardBuilders } from "./cards-api.js";`
- add `cards: CardBuilders;` to `TeamsBotDeps`
- replace every bare call `proposalCard(` / `runningCard(` / `finishedCard(` with `deps.cards.proposalCard(` / `deps.cards.runningCard(` / `deps.cards.finishedCard(`. There are 8 call sites: one `proposalCard` (onMessage), two `runningCard` (onTail + post-start), five `finishedCard` (onDone, onError, onCancelled, busy-refusal, cancel-proposal).

- [ ] **Step 4: Update `@bean/teams`**

- `packages/teams/src/cards.ts`: delete its local `ProposalCardInput` interface (and any local input-shaped inline types); instead `import type { ProposalCardInput, RunningCardInput, FinishedCardInput } from "@bean/core";` and type `runningCard`/`finishedCard` parameters with those. Keep the `AvailableModel`/`CliName` imports it already has if still needed.
- `packages/teams/src/server.ts`: change the imports of `buildTeamsBot`, `BotEffects`, `ConversationStore`, `ProposalStore`, `RunRegistry` from `"./bot.js"` / `"./conversation.js"` / `"./proposals.js"` / `"./runs.js"` to `"@bean/core"`, and add to the `buildTeamsBot({...})` deps object:

```typescript
  cards: { proposalCard, runningCard, finishedCard },
```

with `import { finishedCard, proposalCard, runningCard } from "./cards.js";`.

- [ ] **Step 5: Re-export from core's barrel**

Append to `packages/core/src/index.ts`:

```typescript
export * from "./chatops/bot.js";
export * from "./chatops/cards-api.js";
export * from "./chatops/conversation.js";
export * from "./chatops/proposals.js";
export * from "./chatops/runs.js";
export * from "./chatops/resolve.js";
```

(If any name collides with an existing export, rename nothing — investigate; there should be no collisions.)

- [ ] **Step 6: Fix the moved tests**

- Path updates: `../src/<name>.js` → `../src/chatops/<name>.js`; imports of `@bean/core` types inside these tests → `../src/index.js`.
- `chatops-bot.test.ts`: `makeDeps` must now include a fake `cards` field. Add:

```typescript
const fakeCards = {
  proposalCard: (i: object) => ({ kind: "proposal", ...i }),
  runningCard: (i: object) => ({ kind: "running", ...i }),
  finishedCard: (i: object) => ({ kind: "finished", ...i }),
};
```

and `cards: fakeCards as CardBuilders,` in the deps object (`import type { CardBuilders } from "../src/chatops/cards-api.js";`). Existing assertions that regex/stringify cards (e.g. `"proposalId":"prop-1"`) keep working because the fake echoes its input.

- [ ] **Step 7: Run the full gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 (core now runs the five chatops test files; teams runs its remaining `teams-config` + `cards` tests; app unaffected).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(core): promote chatops brain from @bean/teams, inject CardBuilders"
```

---

### Task 2: Scaffold `@bean/discord` + config loader

**Files:**
- Create: `packages/discord/package.json`, `packages/discord/tsconfig.json`, `packages/discord/vitest.config.ts` (tsconfig/vitest copied verbatim from `packages/teams/`)
- Create: `packages/discord/src/discord-config.ts`
- Test: `packages/discord/__test__/discord-config.test.ts`

**Interfaces:**
- Produces: `DiscordConfig { botToken: string; allowedUserIds: string[] }`, `discordConfigFile(dir: string): string` (= `<dir>/discord.json`), `loadDiscordConfig(file: string): Promise<DiscordConfig>`.

- [ ] **Step 1: Scaffold**

`packages/discord/package.json`:

```json
{
  "name": "@bean/discord",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@bean/core": "workspace:*",
    "discord.js": "^14.16.0"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

Copy `packages/teams/tsconfig.json` and `packages/teams/vitest.config.ts` verbatim. Then `pnpm install`; verify `pnpm ls -r --depth -1` lists `@bean/discord`.

- [ ] **Step 2: Write the failing test**

`packages/discord/__test__/discord-config.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discordConfigFile, loadDiscordConfig } from "../src/discord-config.js";

async function write(config: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bean-discord-"));
  const file = join(dir, "discord.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return file;
}

test("discordConfigFile joins dir with discord.json", () => {
  expect(discordConfigFile("/home/x/.bean")).toBe(join("/home/x/.bean", "discord.json"));
});

test("loads a valid config", async () => {
  const file = await write({ botToken: "t", allowedUserIds: ["123"] });
  expect(await loadDiscordConfig(file)).toEqual({ botToken: "t", allowedUserIds: ["123"] });
});

test("missing file throws with a setup hint", async () => {
  await expect(loadDiscordConfig("/nope/discord.json")).rejects.toThrow(/Discord config missing/);
});

test("invalid JSON throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-discord-"));
  const file = join(dir, "discord.json");
  await writeFile(file, "{nope", "utf8");
  await expect(loadDiscordConfig(file)).rejects.toThrow(/Discord config invalid/);
});

test("empty botToken or empty allowlist throws (would ignore everyone)", async () => {
  await expect(loadDiscordConfig(await write({ botToken: "", allowedUserIds: ["1"] })))
    .rejects.toThrow(/needs botToken and a non-empty allowedUserIds/);
  await expect(loadDiscordConfig(await write({ botToken: "t", allowedUserIds: [] })))
    .rejects.toThrow(/needs botToken and a non-empty allowedUserIds/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @bean/discord exec vitest run __test__/discord-config.test.ts`
Expected: FAIL — cannot resolve `../src/discord-config.js`.

- [ ] **Step 4: Implement**

`packages/discord/src/discord-config.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DiscordConfig {
  botToken: string;
  /** Discord user ids allowed to talk to Bean and confirm runs. Everyone else is silently ignored. */
  allowedUserIds: string[];
}

export function discordConfigFile(dir: string): string {
  return join(dir, "discord.json");
}

export async function loadDiscordConfig(file: string): Promise<DiscordConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Discord config missing: ${file} — create it as {"botToken": "...", "allowedUserIds": ["<your discord user id>"]} ` +
        "(see packages/discord/README.md).",
    );
  }
  let parsed: Partial<DiscordConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<DiscordConfig>;
  } catch {
    throw new Error(`Discord config invalid: ${file}`);
  }
  const ids = Array.isArray(parsed.allowedUserIds) ? parsed.allowedUserIds.filter((x) => typeof x === "string" && x) : [];
  if (!parsed.botToken || ids.length === 0) {
    throw new Error(`Discord config incomplete: ${file} needs botToken and a non-empty allowedUserIds`);
  }
  return { botToken: parsed.botToken, allowedUserIds: ids };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/discord exec vitest run __test__/discord-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/discord pnpm-lock.yaml
git commit -m "feat(discord): scaffold @bean/discord package with discord.json config loader"
```

---

### Task 3: Message chunking

**Files:**
- Create: `packages/discord/src/chunk.ts`
- Test: `packages/discord/__test__/chunk.test.ts`

**Interfaces:**
- Produces: `chunkText(text: string, limit?: number): string[]` — default limit 2000; splits on line boundaries; a single line longer than the limit is hard-split; never returns an empty array for non-empty input; empty input → `[]`.

- [ ] **Step 1: Write the failing test**

`packages/discord/__test__/chunk.test.ts`:

```typescript
import { expect, test } from "vitest";
import { chunkText } from "../src/chunk.js";

test("short text passes through as one chunk", () => {
  expect(chunkText("hello")).toEqual(["hello"]);
});

test("empty text yields no chunks", () => {
  expect(chunkText("")).toEqual([]);
});

test("splits on line boundaries under the limit", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(50)}`);
  const chunks = chunkText(lines.join("\n"), 120);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
  expect(chunks.join("\n")).toBe(lines.join("\n")); // nothing lost
});

test("hard-splits a single over-long line", () => {
  const long = "a".repeat(4500);
  const chunks = chunkText(long, 2000);
  expect(chunks).toEqual(["a".repeat(2000), "a".repeat(2000), "a".repeat(500)]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/discord exec vitest run __test__/chunk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/discord/src/chunk.ts`:

```typescript
/** Split text for Discord's 2000-char message limit: greedy on line boundaries,
 * hard-splitting any single line that alone exceeds the limit. Lossless under join("\n")
 * except that hard-split segments of one line are rejoined without separators by the reader. */
export function chunkText(text: string, limit = 2000): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let current = "";
  const push = (): void => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      push();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();
  return chunks;
}
```

Note: the "nothing lost" test joins with `"\n"`, which holds because that fixture has no over-long lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/discord exec vitest run __test__/chunk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/discord/src/chunk.ts packages/discord/__test__/chunk.test.ts
git commit -m "feat(discord): line-boundary text chunking for the 2000-char limit"
```

---

### Task 4: Discord components (embeds + selects + buttons)

**Files:**
- Create: `packages/discord/src/components.ts`
- Test: `packages/discord/__test__/components.test.ts`

**Interfaces:**
- Consumes: `ProposalCardInput`, `RunningCardInput`, `FinishedCardInput`, `CardBuilders` from `@bean/core` (Task 1).
- Produces: `discordCards: CardBuilders` — each builder returns a **plain JSON message-options object** `{ embeds: [...], components: [...] }` (raw API payload shapes, no discord.js builder instances, so tests assert on plain data and `server.ts` can pass them straight to `send`/`edit`).
- customId contract (parsed by `server.ts`, Task 5): `bean:confirm:<proposalId>`, `bean:cancel-proposal:<proposalId>`, `bean:cancel-run:<proposalId>`, `bean:cli:<proposalId>`, `bean:model:<proposalId>`.

- [ ] **Step 1: Write the failing test**

`packages/discord/__test__/components.test.ts`:

```typescript
import { expect, test } from "vitest";
import { discordCards } from "../src/components.js";

const models = [
  { id: "sonnet", label: "Sonnet", aliases: { claude: "sonnet" }, availableOn: ["claude" as const] },
  { id: "gpt-5-5", label: "GPT-5.5", aliases: { opencode: "github-copilot/gpt-5.5" }, availableOn: ["opencode" as const] },
];

const proposalInput = {
  proposalId: "prop-1", projectName: "bean", skillName: "fix-bug",
  instruction: "fix the <flaky> test & report", clis: ["claude" as const, "opencode" as const],
  models, defaultCli: "claude" as const, defaultModel: "sonnet",
};

test("proposal message shows the verbatim instruction and carries the customId contract", () => {
  const s = JSON.stringify(discordCards.proposalCard(proposalInput));
  expect(s).toContain("fix the <flaky> test & report");
  expect(s).toContain("bean:confirm:prop-1");
  expect(s).toContain("bean:cancel-proposal:prop-1");
  expect(s).toContain("bean:cli:prop-1");
  expect(s).toContain("bean:model:prop-1");
});

test("proposal selects pre-select the resolved cli and model", () => {
  const card = discordCards.proposalCard(proposalInput) as {
    components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[];
  };
  const selects = card.components.flatMap((row) => row.components).filter((c) => c.options);
  const cli = selects.find((c) => c.custom_id === "bean:cli:prop-1");
  const model = selects.find((c) => c.custom_id === "bean:model:prop-1");
  expect(cli?.options?.find((o) => o.default)?.value).toBe("claude");
  expect(model?.options?.find((o) => o.default)?.value).toBe("sonnet");
});

test("running message carries cancel-run and the tail in a code block", () => {
  const s = JSON.stringify(discordCards.runningCard({
    projectName: "bean", instruction: "x", startedBy: "scen", tail: "▸ Bash", projectPath: "/p/bean",
  }));
  expect(s).toContain("bean:cancel-run:");
  expect(s).toContain("▸ Bash");
  expect(s).toContain("scen");
});

test("finished message has no components", () => {
  const card = discordCards.finishedCard({
    projectName: "bean", instruction: "x", startedBy: "scen", outcome: "done",
  }) as { components: unknown[] };
  expect(card.components).toEqual([]);
  expect(JSON.stringify(card)).toContain("done");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/discord exec vitest run __test__/components.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/discord/src/components.ts`:

```typescript
import type { CardBuilders, FinishedCardInput, ProposalCardInput, RunningCardInput } from "@bean/core";

// Raw Discord API component payloads (type 1 = action row, 2 = button, 3 = string select).
// Plain JSON keeps the builders pure/testable and discord.js accepts them directly.
const BUTTON = 2;
const STRING_SELECT = 3;
const row = (components: object[]): object => ({ type: 1, components });

function proposalCard(input: ProposalCardInput): object {
  const cliSelect = {
    type: STRING_SELECT,
    custom_id: `bean:cli:${input.proposalId}`,
    placeholder: "CLI",
    options: input.clis.map((c) => ({ label: c, value: c, default: c === input.defaultCli })),
  };
  const modelSelect = {
    type: STRING_SELECT,
    custom_id: `bean:model:${input.proposalId}`,
    placeholder: "Model",
    options: input.models
      .filter((m) => m.availableOn.length > 0)
      .map((m) => ({
        label: `${m.label} (${m.availableOn.join("/")})`,
        value: m.id,
        default: m.id === input.defaultModel,
      })),
  };
  const buttons = [
    { type: BUTTON, style: 3, label: "Run", custom_id: `bean:confirm:${input.proposalId}` },
    { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-proposal:${input.proposalId}` },
  ];
  return {
    embeds: [{
      title: "Bean proposes a delegate run",
      description: input.instruction,
      fields: [
        { name: "Project", value: input.projectName, inline: true },
        ...(input.skillName ? [{ name: "Skill", value: input.skillName, inline: true }] : []),
      ],
    }],
    components: [row([cliSelect]), row([modelSelect]), row(buttons)],
  };
}

function runningCard(input: RunningCardInput): object {
  return {
    embeds: [{
      title: `Running in ${input.projectName}… (started by ${input.startedBy})`,
      description: input.instruction,
      ...(input.tail ? { fields: [{ name: "Progress", value: `\`\`\`\n${input.tail}\n\`\`\`` }] } : {}),
    }],
    // cancel-run carries the projectPath in the customId's id slot; server.ts resolves it
    // via its proposal-message state (spec: adapter-local maps). Using projectPath directly
    // here keeps the id self-contained instead.
    components: [row([{ type: BUTTON, style: 4, label: "Cancel run", custom_id: `bean:cancel-run:${input.projectPath}` }])],
  };
}

function finishedCard(input: FinishedCardInput): object {
  return {
    embeds: [{
      title: `Run ${input.outcome} in ${input.projectName} (started by ${input.startedBy})`,
      description: input.instruction,
    }],
    components: [],
  };
}

export const discordCards: CardBuilders = { proposalCard, runningCard, finishedCard };
```

Design note (deviation from the spec's customId sketch, resolved here): `bean:cancel-run:<projectPath>` embeds the project path directly instead of a proposalId, because `RunningCardInput` already carries `projectPath` and `bot.ts`'s `cancel-run` branch expects `value.projectPath` — this removes the need for the server-side proposalId→projectPath map entirely. `server.ts` (Task 5) parses the third segment as `projectPath` for `cancel-run` and as `proposalId` for every other action (split on `":"` with a 3-way `split(/^bean:([a-z-]+):(.*)$/)`-style parse so paths containing `:` are safe — the payload is everything after the second colon).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/discord exec vitest run __test__/components.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/discord/src/components.ts packages/discord/__test__/components.test.ts
git commit -m "feat(discord): embed/select/button builders implementing CardBuilders"
```

---

### Task 5: Discord server wiring

**Files:**
- Create: `packages/discord/src/server.ts`

**Interfaces:**
- Consumes: `buildTeamsBot`, `BotEffects`, `CardAction`, stores, loaders, `detectClis`, `runDelegate`, `makeOpenAIConverse`, config-path helpers — all from `@bean/core`; `discordCards` (Task 4), `chunkText` (Task 3), `loadDiscordConfig`/`discordConfigFile` (Task 2).
- Produces: `dist/server.js` startable via `pnpm --filter @bean/discord start`. No unit tests (impure wiring, same status as the teams/app wiring); `pnpm build && pnpm typecheck` is the gate plus a smoke run.

- [ ] **Step 1: Implement**

`packages/discord/src/server.ts` (starting point — adjust against installed discord.js v14 types until typecheck passes; do not weaken tsconfig):

```typescript
import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory,
  detectClis, runDelegate,
  buildTeamsBot, ConversationStore, ProposalStore, RunRegistry, type BotEffects,
} from "@bean/core";
import {
  ChannelType, Client, GatewayIntentBits, Partials,
  type Interaction, type Message, type MessageCreateOptions, type TextBasedChannel,
} from "discord.js";
import { chunkText } from "./chunk.js";
import { discordCards } from "./components.js";
import { discordConfigFile, loadDiscordConfig } from "./discord-config.js";

const dir = beanDir();
const discordConfig = await loadDiscordConfig(discordConfigFile(dir));
const beanConfig = await loadConfig(configFile(dir), dir);
if (!beanConfig.openaiApiKey) throw new Error("openaiApiKey missing in ~/.bean/config.json");

const clis = detectClis();
const bot = buildTeamsBot({
  chat: makeOpenAIConverse(beanConfig.openaiApiKey),
  model: beanConfig.model,
  loadSkills: () => loadLayeredSkills(skillsDir(projectBeanDir()), skillsDir(dir)),
  loadProjects: () => loadProjects(projectsFile(dir)),
  loadPersona: () => loadPersona(personaFile(dir), personaFile(projectBeanDir())),
  loadMemories: () => loadMemories(memoryFile(dir)),
  loadModelMemory: () => loadModelMemory(modelMemoryFile(dir)),
  saveModelMemory: (m) => saveModelMemory(modelMemoryFile(dir), m),
  detectClis: () => clis,
  runs: new RunRegistry(runDelegate),
  proposals: new ProposalStore(),
  conversations: new ConversationStore(),
  cards: discordCards,
});

// Partials.Channel is REQUIRED for DM message events in discord.js v14 (DM channels
// arrive uncached); Message Content intent must also be enabled in the developer portal.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Latest select-menu choices per proposal message id — Discord sends each select change
// as its own interaction, so the values must be cached until the Run button is pressed.
// Entries die with the proposal (deleted on confirm/cancel).
const selections = new Map<string, { cli?: string; model?: string }>();

const allowed = (userId: string): boolean => discordConfig.allowedUserIds.includes(userId);

function effectsFor(channel: TextBasedChannel): BotEffects {
  const send = async (options: string | MessageCreateOptions): Promise<Message> => {
    if (!("send" in channel)) throw new Error("channel is not sendable");
    return channel.send(options as MessageCreateOptions);
  };
  return {
    reply: async (text) => { for (const c of chunkText(text)) await send(c); },
    post: async (text) => { for (const c of chunkText(text)) await send(c); },
    postCard: async (card) => (await send(card as MessageCreateOptions)).id,
    updateCard: async (activityId, card) => {
      if (!("messages" in channel)) return;
      const msg = await channel.messages.fetch(activityId);
      await msg.edit(card as Parameters<Message["edit"]>[0]);
    },
  };
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !allowed(message.author.id)) return;
    const isDm = message.channel.type === ChannelType.DM;
    if (!isDm && !message.mentions.users.has(client.user?.id ?? "")) return;
    const text = message.content.replace(new RegExp(`<@!?${client.user?.id ?? ""}>`, "g"), "").trim();
    if (!text) return;
    await bot.onMessage(
      { conversationId: message.channelId, text, fromId: message.author.id, fromName: message.author.displayName },
      effectsFor(message.channel),
    );
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (!allowed(interaction.user.id)) return;
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const match = /^bean:([a-z-]+):(.*)$/.exec(interaction.customId);
    if (!match?.[1] || match[2] === undefined) return;
    const [, action, payload] = match;
    await interaction.deferUpdate(); // ack within Discord's 3s window before slow work

    if (interaction.isStringSelectMenu()) {
      const sel = selections.get(interaction.message.id) ?? {};
      if (action === "cli") sel.cli = interaction.values[0];
      if (action === "model") sel.model = interaction.values[0];
      selections.set(interaction.message.id, sel);
      return;
    }

    if (!interaction.channel) return;
    const fx = effectsFor(interaction.channel);
    if (action === "cancel-run") {
      await bot.onCardAction(
        { conversationId: interaction.channelId, fromName: interaction.user.displayName, value: { beanAction: "cancel-run", projectPath: payload } },
        fx,
      );
      return;
    }
    const sel = selections.get(interaction.message.id) ?? {};
    selections.delete(interaction.message.id);
    await bot.onCardAction(
      {
        conversationId: interaction.channelId,
        fromName: interaction.user.displayName,
        value: { beanAction: action, proposalId: payload, cli: sel.cli, model: sel.model },
      },
      fx,
    );
  } catch (err) {
    console.error("interactionCreate error:", err);
  }
});

client.on("error", (err) => console.error("client error:", err));

client.once("clientReady", () => {
  console.log(`@bean/discord logged in as ${client.user?.tag} (clis: ${clis.join(", ") || "none"})`);
});
await client.login(discordConfig.botToken);
```

Implementer notes:
- discord.js v14.16+ renamed the ready event to `clientReady` (`ready` still works with a deprecation warning) — use whichever the installed version's types accept without warnings.
- `interaction.channel` on a `ButtonInteraction` may be typed nullable and as `TextBasedChannel | null`; the guard above handles it. If `displayName` isn't on `User` in the installed version, use `interaction.user.username` / `message.author.username`.
- The `value: { beanAction: action, ... }` passes `action` as a plain string — `CardAction.value.beanAction` is `string | undefined`, so this typechecks; `bot.ts` ignores unknown values.

- [ ] **Step 2: Typecheck and build**

Run: `pnpm build && pnpm typecheck`
Expected: both exit 0 across all four packages.

- [ ] **Step 3: Smoke-run**

Run: `node packages/discord/dist/server.js`
Expected: either "logged in as …" (valid `~/.bean/discord.json` present — then Ctrl-C) or the "Discord config missing" setup-hint error. Either is a pass; record which.

- [ ] **Step 4: Commit**

```bash
git add packages/discord/src/server.ts
git commit -m "feat(discord): gateway server wiring with allowlist and select caching"
```

---

### Task 6: README, memory update, final validation

**Files:**
- Create: `packages/discord/README.md`
- Modify: `.memory/project-teams-bot.md` (bot brain now lives in core/chatops — the entry must not contradict the code)
- Modify: `.memory/INDEX.md` (update the same line's hook text)

**Interfaces:** none — documentation and validation.

- [ ] **Step 1: Write the README**

`packages/discord/README.md`:

```markdown
# @bean/discord — Bean in your DMs and personal server (POC)

Personal single-user Discord adapter over the same chatops brain as `@bean/teams`
(`packages/core/src/chatops/`). Gateway (outbound WebSocket) — no tunnel, no public
endpoint. Design: `docs/superpowers/specs/2026-07-10-discord-adapter-design.md`.

## One-time setup

1. **Create the bot**: discord.com/developers → New Application → Bot. Copy the **bot token**.
   Under *Privileged Gateway Intents*, enable **Message Content Intent**.
2. **Invite it**: OAuth2 → URL Generator → scope `bot` → permissions: View Channels,
   Send Messages, Read Message History → open the URL, add to your private server.
3. **Your user id**: Discord settings → Advanced → enable Developer Mode, then right-click
   your name → "Copy User ID".
4. **Config**: create `~/.bean/discord.json`:
   `{ "botToken": "<token>", "allowedUserIds": ["<your user id>"] }`

## Run

    pnpm build
    pnpm --filter @bean/discord start

@mention the bot in a server channel, or DM it (no mention needed in DMs). Only allowlisted
user ids get responses; everyone else is silently ignored. Saying a CLI/model in the message
("with opencode on GPT-5.5") is honored; delegate runs are confirm-first via buttons and
execute on THIS machine.

## Manual verification checklist

- [ ] Server logs "logged in as …" with detected CLIs.
- [ ] DM hello → reply (no mention needed).
- [ ] Guild @mention hello → reply; un-mentioned guild message → ignored.
- [ ] Message from a non-allowlisted account → ignored (messages and buttons).
- [ ] "summarize the bean repo" → proposal embed with CLI/model selects + Run/Cancel.
- [ ] Changing a select then Run → run starts with the chosen cli/model.
- [ ] Running embed updates with tail lines; result posts when done (chunked if >2000 chars).
- [ ] Second confirm while the project is busy → polite refusal.
- [ ] Cancel run → embed flips to cancelled. Text "cancel" also cancels.
- [ ] Proposal older than 10 min → "expired" on Run.
```

- [ ] **Step 2: Update team memory**

Rewrite `.memory/project-teams-bot.md` (keeping its file name — INDEX links to it) so the architecture bullets read:

```markdown
# project-teams-bot

Bean has two chat adapters over one shared brain:

- **Brain**: `packages/core/src/chatops/` — `bot.ts` (buildTeamsBot; name kept for history),
  conversation/proposal/run stores, cli-model resolve. Pure/DI'd; card builders are injected
  via `CardBuilders` (`cards-api.ts`), so the brain has zero presentation code.
- **Adapters**: `packages/teams/` (Azure Bot + Adaptive Cards + tunnel; work group) and
  `packages/discord/` (gateway + embeds/buttons; personal, allowlist-only). Each is
  config + card builders + one impure `server.ts`.
- Specs: docs/superpowers/specs/2026-07-10-teams-bot-design.md and
  2026-07-10-discord-adapter-design.md.
- `converse()` grew a trailing `availableClis` param; `ProposedDelegate` has optional
  `cli`/`model` (chat-stated). Backward-compatible; the desktop ignores them so far.
- Model memory keys `teams:cli` / `teams:model:<cli>` are intentionally shared by ALL chat
  adapters (historical name) in ~/.bean/model-memory.json beside the desktop's skillName
  keys. Don't rename or "clean up" either side.
- Conversation/proposal state is in-memory by design (POC): restart = amnesia.
```

Update the line in `.memory/INDEX.md` to:

```markdown
- [project-teams-bot](project-teams-bot.md) — chatops brain in core + Teams/Discord adapters; model-memory key namespacing.
```

- [ ] **Step 3: Full validation gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across all four packages.

- [ ] **Step 4: Commit**

```bash
git add packages/discord/README.md .memory/project-teams-bot.md .memory/INDEX.md
git commit -m "docs(discord): runbook; update team memory for chatops promotion"
```

---

## Execution notes

- Strictly sequential: Task 1 (the move) touches what Tasks 2–5 build on; Tasks 3 and 4 could run in parallel after 2, but sequential execution is fine at this size.
- After Task 6, the branch holds both adapters; finish via superpowers:finishing-a-development-branch (single PR into `main`).
