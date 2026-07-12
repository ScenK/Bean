# deliver() Fanout Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable `deliver()` fanout layer that sends a message to multiple transports, with macOS Notification wired live and Discord/Teams/bubble as marked stubs.

**Architecture:** A pure, dependency-injected `deliver(msg, transports)` in `@bean/core` fans a `DeliverMessage` to every `available()` transport via `Promise.allSettled`, isolating per-transport failures. Electron-bound transports are constructed in `packages/app/src/main.ts` and injected; the reminder poll switches from an inline `new Notification(...)` to `deliver(...)`.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`), vitest, Electron (`Notification`).

## Global Constraints

- Node ≥24, pnpm 11. Both packages are ESM (`"type": "module"`) — use `.js` extensions in relative imports and `import type` for type-only imports.
- `strict` + `noUncheckedIndexedAccess` on — array access is `T | undefined`.
- `@bean/core` is Electron-free: no `electron` import may appear in any `packages/core/**` file.
- Files: kebab-case `.ts`.
- Validation gate: `pnpm test && pnpm typecheck` must exit 0 before claiming done.
- Mark deliberate simplifications with a `ponytail:` comment naming the upgrade path.

---

### Task 1: Core `deliver()` function + types

**Files:**
- Create: `packages/core/src/deliver.ts`
- Modify: `packages/core/src/index.ts:13` (add barrel export after the `./reminders.js` line)
- Test: `packages/core/__test__/deliver.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface DeliverMessage { body: string; title?: string; meta?: Record<string, unknown>; }`
  - `interface Transport { name: string; available(): boolean; send(msg: DeliverMessage): void | Promise<void>; }`
  - `interface DeliverOutcome { name: string; ok: boolean; error?: unknown; }`
  - `function deliver(msg: DeliverMessage, transports: Transport[]): Promise<DeliverOutcome[]>` — returns one outcome per `available()` transport, in input order; unavailable transports are skipped entirely (no outcome entry).

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/deliver.test.ts`:

```typescript
import { expect, test } from "vitest";
import { deliver, type Transport, type DeliverMessage } from "../src/deliver.js";

function transport(name: string, available: boolean, sink: DeliverMessage[], throws = false): Transport {
  return {
    name,
    available: () => available,
    send: (msg) => {
      if (throws) throw new Error(`${name} boom`);
      sink.push(msg);
    },
  };
}

test("fans to available transports and skips unavailable ones", async () => {
  const a: DeliverMessage[] = [];
  const b: DeliverMessage[] = [];
  const msg: DeliverMessage = { body: "hi" };
  const outcomes = await deliver(msg, [transport("a", true, a), transport("b", false, b)]);
  expect(a).toEqual([msg]);
  expect(b).toEqual([]);
  expect(outcomes).toEqual([{ name: "a", ok: true }]);
});

test("one throwing transport does not block the others", async () => {
  const good: DeliverMessage[] = [];
  const msg: DeliverMessage = { body: "hi" };
  const outcomes = await deliver(msg, [
    transport("bad", true, [], true),
    transport("good", true, good),
  ]);
  expect(good).toEqual([msg]);
  expect(outcomes[0]!.name).toBe("bad");
  expect(outcomes[0]!.ok).toBe(false);
  expect(outcomes[0]!.error).toBeInstanceOf(Error);
  expect(outcomes[1]).toEqual({ name: "good", ok: true });
});

test("empty / all-unavailable list resolves to no outcomes without throwing", async () => {
  expect(await deliver({ body: "x" }, [])).toEqual([]);
  expect(await deliver({ body: "x" }, [transport("off", false, [])])).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/deliver.test.ts`
Expected: FAIL — cannot resolve `../src/deliver.js` / `deliver is not defined`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/deliver.ts`:

```typescript
export interface DeliverMessage {
  body: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export interface Transport {
  name: string;
  available(): boolean;
  send(msg: DeliverMessage): void | Promise<void>;
}

export interface DeliverOutcome {
  name: string;
  ok: boolean;
  error?: unknown;
}

// Fans a message to every available transport, isolating failures so one dead
// channel never blocks the others. Returns one outcome per available transport,
// in input order; unavailable transports are skipped entirely.
export async function deliver(msg: DeliverMessage, transports: Transport[]): Promise<DeliverOutcome[]> {
  const active = transports.filter((t) => t.available());
  const results = await Promise.allSettled(active.map((t) => Promise.resolve(t.send(msg))));
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? { name: active[i]!.name, ok: true }
      : { name: active[i]!.name, ok: false, error: r.reason },
  );
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/core/src/index.ts`, add after line 13 (`export * from "./reminders.js";`):

```typescript
export * from "./deliver.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/deliver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck core**

Run: `pnpm --filter @bean/core exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/deliver.ts packages/core/src/index.ts packages/core/__test__/deliver.test.ts
git commit -m "feat(core): add deliver() fanout layer"
```

---

### Task 2: Wire transports in main and route reminders through deliver()

**Files:**
- Modify: `packages/app/src/main.ts:12` (import `deliver` + its types from `@bean/core`)
- Modify: `packages/app/src/main.ts:218-313` (build transports array; swap reminder poll body)

**Interfaces:**
- Consumes: `deliver`, `DeliverMessage`, `Transport` from `@bean/core` (Task 1).
- Produces: nothing consumed by later tasks (terminal task).

- [ ] **Step 1: Add the imports**

In `packages/app/src/main.ts`, add `deliver` to the value import block (the `from "@bean/core"` at lines 7-14), e.g. append to line 13's list:

```typescript
  loadNotes, saveNote, deleteNote, notesDir, detectClis, loginShellPath, deliver,
```

And add the types to the `import type` on line 15:

```typescript
import type { RouteSuggestion, ActionTool, Transport } from "@bean/core";
```

- [ ] **Step 2: Build the transports array**

In `packages/app/src/main.ts`, immediately after `const remindersPath = remindersFile(dir);` (line 221), insert:

```typescript
  // Message fanout: deliver() sends to every available() transport. Only Notification is
  // real today; the rest are honest stubs the routine feature will implement.
  const notificationTransport: Transport = {
    name: "notification",
    available: () => Notification.isSupported(),
    send: (msg) => {
      const n = new Notification({ title: msg.title ?? "Bean", body: msg.body });
      n.on("click", () => openComponent("chat"));
      n.show();
    },
  };
  // ponytail: stub seam — no avatar message-bubble UI exists yet. Add real IPC +
  // renderer rendering when the routine feature needs it.
  const bubbleTransport: Transport = { name: "bubble", available: () => false, send: () => {} };
  // ponytail: stub seams — bots are inbound-only, no main->bot outbound push path exists yet.
  // Build the main->server channel when the routine feature lands.
  const discordTransport: Transport = { name: "discord", available: () => false, send: () => {} };
  const teamsTransport: Transport = { name: "teams", available: () => false, send: () => {} };
  const transports: Transport[] = [notificationTransport, bubbleTransport, discordTransport, teamsTransport];
```

Note: `openComponent` is already in scope at this point in `main.ts` (used by the existing poll at line 307).

- [ ] **Step 3: Route the reminder poll through deliver()**

In the poll at `packages/app/src/main.ts:299-313`, replace the `for (const r of due) { ... }` body (lines 305-310) so it uses `deliver` instead of constructing a `Notification` inline:

```typescript
      for (const r of due) {
        void deliver({ body: r.text }, transports).then((outcomes) => {
          for (const o of outcomes) if (!o.ok) console.error("bean: deliver failed", o.name, o.error);
        });
        r.firedAt = firedAt;
      }
```

Leave the surrounding `loadReminders` / `dueReminders` / `saveReminders` lines unchanged.

- [ ] **Step 4: Typecheck the app**

Run: `pnpm --filter @bean/app exec tsc --noEmit`
Expected: no output, exit 0. (Confirms `openComponent` is in scope and no unused-import errors.)

- [ ] **Step 5: Full gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0.

- [ ] **Step 6: Manual smoke test (Notification transport)**

Run: `pnpm dev`
In the chat, ask Bean to remind you in one minute (or add a due entry to `~/.bean/reminders.json` with an `at` in the past and no `firedAt`). Within 30s a macOS "Bean" notification appears with the reminder text; clicking it opens the chat window. Confirms behavior is unchanged from the pre-`deliver()` inline path.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/main.ts
git commit -m "feat(app): route reminders through deliver() with transport stubs"
```

---

## Self-Review

**Spec coverage:**
- `DeliverMessage` / `Transport` / `deliver` in core — Task 1. ✓
- Notification transport real + click-opens-chat — Task 2 Step 2. ✓
- bubble / discord / teams stubs with `ponytail:` comments — Task 2 Step 2. ✓
- Reminder poll switched to `deliver` — Task 2 Step 3. ✓
- Error isolation via `Promise.allSettled` + logging `ok: false` — Task 1 Step 3, Task 2 Step 3. ✓
- Tests: fan-out/skip, throwing-transport, empty-list — Task 1 Step 1. ✓
- Scope boundary (no bubble UI, no bot push path, no routine feature) — honored; stubs only. ✓

**Placeholder scan:** none — all code shown in full.

**Type consistency:** `DeliverMessage`, `Transport`, `DeliverOutcome`, `deliver` names/signatures identical across Task 1 (definition) and Task 2 (use). Transport names `notification`/`bubble`/`discord`/`teams` consistent with the spec's `ChatopsBot` mirroring.
