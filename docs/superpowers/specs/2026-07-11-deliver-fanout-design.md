# deliver() fanout layer — design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan

## Goal

Introduce a `deliver()` abstraction that fans a message out to multiple transports
(macOS Notification, avatar bubble/badge, Discord DM, Teams DM). It becomes the reusable
entry point a future **routine feature** will use to push messages/notifications across
devices. This task builds the layer and the one transport that is real and testable today
(Notification); the others ship as honest, marked stubs.

## Current state (why the transports are asymmetric)

- **Reminder firing** — `packages/app/src/main.ts:299-313`: a 30s poll calls
  `new Notification({ title: "Bean", body: r.text })` inline. This is the only current
  caller that needs a "message to the user" path.
- **Avatar bubble/badge** — no existing mechanism. `.bean-bubble` is chat-window message
  bubbles; avatar "badges" are per-tile inside the hover/drag menus. Showing a transient
  message bubble or notification badge on the resting avatar is net-new renderer UI + IPC.
- **Discord / Teams** — `packages/discord/src/server.ts` (and the Teams equivalent) are
  **inbound-only, reactive** processes: they log in, listen for a message from the user,
  and reply on that same channel (`effectsFor(message.channel)`). Bean's main process has
  **no outbound channel** to tell a running bot "DM the user this." That path does not exist.

So only Notification is trivially reachable and testable from main today. Bubble and DM are
both deferred seams.

## Approach (chosen: A)

A minimal pure `deliver()` in `@bean/core`, with Electron-bound transports wired in `main.ts`.
Fits the repo convention: IO/policy is a pure, dependency-injected core function; Electron
wiring lives in `app/`.

Rejected alternatives:
- **B — build the outbound bot-push path now.** Untestable end-to-end until the routine
  feature + a live bot token exist. Speculative; deferred.
- **C — no core layer, inline loop in main.** Laziest, but a pure core `deliver` is the
  reusable, testable seam routines will import; A's tiny extra cost buys exactly that.

## Design

### 1. Core: `packages/core/src/deliver.ts` (pure, DI'd)

```typescript
export interface DeliverMessage {
  body: string;                       // the notification/DM/bubble text
  title?: string;                     // defaults to "Bean" at the transport
  meta?: Record<string, unknown>;     // free-form; routines can pass source/id/etc.
}

export interface Transport {
  name: string;                       // "notification" | "bubble" | "discord" | "teams"
  available(): boolean;               // skip cleanly when not usable (bot down, stub, etc.)
  send(msg: DeliverMessage): void | Promise<void>;
}

// Fans a message to every available transport, isolating failures so one dead
// channel never blocks the others. Returns per-transport outcomes for logging/tests.
export async function deliver(
  msg: DeliverMessage,
  transports: Transport[],
): Promise<{ name: string; ok: boolean; error?: unknown }[]>;
```

`deliver` filters to `available()` transports, `Promise.allSettled`s their `send`, maps
results to the outcome array. Zero Electron — transports are injected. Exported from
`packages/core/src/index.ts`.

### 2. App: transports wired in `packages/app/src/main.ts`

Built once near the reminder poll:

```typescript
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

// ponytail: stub seam — no outbound main->bot push path exists yet (bots are
// inbound-only). Build main->server channel when the routine feature lands.
const discordTransport: Transport = { name: "discord", available: () => false, send: () => {} };
const teamsTransport: Transport = { name: "teams", available: () => false, send: () => {} };

const transports = [notificationTransport, bubbleTransport, discordTransport, teamsTransport];
```

Two separate DM stubs (`discord` + `teams`) mirror `ChatopsBot` and the stated
fanout-per-device goal.

### 3. Reminder poll change (`main.ts:305-310`)

```typescript
for (const r of due) {
  void deliver({ body: r.text }, transports);  // title defaults to "Bean"
  r.firedAt = firedAt;
}
```

Only `notification` is `available()` today, so behavior is identical to now — the seam is
simply in place.

## Error handling

`deliver` uses `Promise.allSettled`; a throwing/rejecting transport is captured as
`{ name, ok: false, error }` and never blocks the others. Main logs `ok: false` outcomes
(`console.error("bean: deliver failed", ...)`), same fire-and-forget spirit as
`launcher.ts`'s `fireAndForget`. A failed transport does not stop a reminder from being
marked `firedAt`.

## Test plan

`packages/core/__test__/deliver.test.ts` (vitest) — the only new test, since `deliver` is
the one piece of non-trivial logic:
- fans to all `available()` transports, skips unavailable ones
- one transport throwing → others still receive the message; outcome array reflects
  `ok: false` for the thrower
- empty / all-unavailable transport list → resolves to an all-skipped outcome array, no throw

Electron transports (`notification`, stubs) are not unit-tested — thin Electron wiring in
`main.ts`, consistent with the repo pattern (core tested, app wiring not). Notification is
verified manually by firing a due reminder in `pnpm dev`.

Gate: `pnpm test && pnpm typecheck` exit 0.

## Scope boundary (explicitly NOT in this task)

- No avatar bubble/badge UI.
- No main→bot outbound path (Discord/Teams DM stays a stub).
- No routine feature.

Those are the deferred seams the stubs mark; the routine feature (separate task) fills them
in when they can actually be exercised.
