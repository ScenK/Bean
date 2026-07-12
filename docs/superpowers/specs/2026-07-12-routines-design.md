# Routines — Design Spec

**Date:** 2026-07-12
**Status:** Approved for planning

Bean gains a Routines feature: user-defined, cron-scheduled, multi-step automations that
run delegated CLI tasks and chat-model steps (with Bean's tool pool), then fan a single
digest out to configurable sinks (chatops, note, run history).

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Scheduler engine | **In-app scheduler** (tick loop in main process while Bean runs). No launchd. |
| Storage | **`~/.bean/routines/<name>.json`**, one file per routine. |
| Step model | **Two explicit kinds**: `delegate` (headless CLI run) and `chat` (Bean's model + tool pool). |
| Autonomy | **Pre-authorized**: saving a routine is consent. Steps use act-now tools; no propose_* / ProposalCards in routine runs. |
| Output | **One digest at the end**, delivered via `deliver()` to per-routine sinks. Dashboard is a separate later ticket. |
| Failure | **Continue on failure**; failures marked in the digest. Per-step timeout. |
| Cadence | **5-field cron string**, own ~100-line parser in core (no dependency); panel edits via friendly dropdowns. |
| Overlap | Skip a tick if the same routine is still running (different routines may run concurrently). |
| Catch-up | **No auto catch-up** for schedules missed while Bean was closed; panel shows "missed" + Run now. |

## 1. Data model & storage

One JSON file per routine in `~/.bean/routines/`, loaded by a pure `routine-store.ts` in
`@bean/core` (invalid/missing files degrade to `[]`, same as skills/projects):

```ts
interface Routine {
  name: string;              // filename stem, unique
  description?: string;
  enabled: boolean;
  cron: string;              // 5-field cron, local time
  steps: RoutineStep[];
  sinks: {
    chatops?: { transport: "teams" | "discord"; channel: string }[]; // opt-in
    note?: boolean;                                                  // opt-in
  };
}

type RoutineStep =
  | {
      kind: "delegate";
      skill: string;
      project?: string;      // undefined → existing scratch-workspace ("no project") flow
      model?: string;        // undefined → Bean picks via existing model-memory
      instruction: string;
    }
  | { kind: "chat"; skill?: string; model?: string; instruction: string };
```

Runtime state lives separately in `~/.bean/routines/.state.json` (per-routine `lastRun`
timestamp, running flag, last N=20 run records) so routine definitions stay clean and
shareable. Panel edits write the definition files; the panel reloads from disk on open so
hand edits are picked up (no file watcher in v1).

## 2. Scheduler (core, pure; wiring in app)

- `core/src/cron.ts` — parse the 5-field cron subset (minute, hour, day-of-month, month,
  day-of-week; `*`, lists, ranges, steps) and compute `nextRun(cron, from: Date): Date`.
  Local time. No dependency; fully table-tested.
- `core/src/routine-runner.ts` — `runRoutine(routine, deps)` with injected
  `deps.chat`, `deps.delegate`, `deps.deliver`, `deps.now`, etc. Runs steps sequentially,
  continue-on-failure, per-step timeout (default 15 min; delegate steps cancelled via
  `runDelegate`'s process-group kill). Produces `StepResult[]` and the digest.
- `app/src/routine-scheduler.ts` — main-process tick (~30s, same spirit as the reminders
  due-check): a routine is due when `nextRun(cron, lastRun) <= now`. Enforces
  skip-if-running per routine; records misses (Bean closed at fire time) as state the
  panel can show; never auto-runs missed schedules.

## 3. Step execution

- **Delegate step** → composed skill prompt + instruction through the existing
  `runDelegate()` path, tracked in `delegate-tasks.ts` alongside chat-initiated delegates
  so cancel machinery is shared — but lifetime is bound to the app, not the chat window.
- **Chat step** → the `converse()` tool loop in a routine mode: act-now tool pool
  (fetch_url, save note, retrieve note, reminders) plus prior step outputs injected as
  context, so e.g. "save the previous step's summary to notes" works. No propose_* tools,
  no ProposalCards, no run proposals. A routine-written note is still "explicit" per the
  notes convention: the user authored the instruction that writes it.
- Each step receives a compact summary of all prior steps' outputs.

## 4. Digest & fanout

After the last step, one chat-model summarization pass composes a single digest from all
`StepResult`s; failed steps are included and clearly marked. Delivery goes through the
existing `deliver()` / `Transport` layer:

- **Run history** (always): run record appended to `.state.json`, capped at 20 per
  routine; shown in the panel.
- **Chatops** (opt-in per routine): Teams/Discord via the existing adapters, addressed to
  a channel selected in the panel from those the bots already know.
- **Note** (opt-in): writes/updates a `routine: <name>` note update-in-place, like
  linked-chat notes. (Daily Dashboard integration is a separate future ticket.)

## 5. Panel UI

New `routines` component window, registered like the existing ones (component-window
registry, esbuild entry, `windows.ts`, tray/avatar menu entry; follow the no-fake-chrome
window rule). Layout follows the mockup:

- Left: routine list with enable toggles, per-routine status dot
  (ok / failed / missed / running), "New routine".
- Right: editor — name, description, "Runs automatically" toggle; cadence dropdowns with
  read-only raw cron + computed next-run; ordered step cards (kind, skill/project/model
  pickers reusing existing pickers, instruction textarea, add/remove/reorder); sink
  configuration; **Run now**; Save.

## 6. IPC & wiring

New channels defined once in `app/src/channels.ts`:
`bean:routines-list`, `bean:routines-save`, `bean:routines-delete`,
`bean:routines-run-now`, `bean:routines-state`. Handlers kept thin and Electron-separable
(`buildRoutineHandlers`) in `ipc.ts`; the scheduler starts from `main.ts` after config
load and stops on quit.

## 7. Testing

- **Core:** cron parser table tests; routine-runner tests with fake
  chat/delegate/deliver/now covering step ordering, continue-on-failure, timeout/cancel,
  prior-output threading, digest content, sink selection, and overlap-skip.
- **App:** handler tests in the existing ipc test style; scheduler due/miss logic with a
  fake clock.
- **Gate:** `pnpm test && pnpm typecheck`. Since this touches app boot, IPC, and windows,
  watch the advisory e2e job on the PR.

## Out of scope

- launchd / run-while-closed scheduling.
- Daily Dashboard sink (separate ticket).
- Per-step fanout, per-routine catch-up flag, `continueOnError` per step — possible later
  additions layered on this design.
