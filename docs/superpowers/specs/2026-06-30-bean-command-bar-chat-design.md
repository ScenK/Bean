# Bean — Dashboard Redesign, Sub-Project 2: Command Bar + Chat — Design

Date: 2026-06-30
Status: Approved for planning
Depends on: [2026-06-30-bean-dashboard-foundation-design.md](2026-06-30-bean-dashboard-foundation-design.md) (SP1, complete)
Roadmap: [.memory/project-dashboard-redesign-roadmap.md](../../../.memory/project-dashboard-redesign-roadmap.md)

## 1. Summary

Turn the dashboard's placeholder Chat and Command Bar panels into a working
conversational surface. The user talks to Bean in the chat; the conversational model
(OpenAI, via a new tool-calling path) replies normally and, when it judges the user wants
work done, calls a `propose_run` tool that renders an editable **confirm card** in the
thread. Confirming fires the existing `runOpencode` subprocess; run status flows back into
the chat as status bubbles. The command bar is an always-visible input that seeds a
message into the same flow and shows a chip for any URL dropped on the avatar.

This is the first LLM use beyond the router and **reverses the original MVP non-goal**
"OpenAI conversational chat" — an explicit, user-approved scope change for the redesign.

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Chat nature | Real conversational LLM (multi-turn), not a lifecycle transcript. |
| Bar vs chat | Chat is primary and can trigger routing/runs; command bar is a quick-entry that seeds the same flow. |
| Route trigger | The conversational model owns the decision via a `propose_run` tool call (function-calling). Not a parallel router pass. |
| Chat history | Ephemeral — in-memory in the dashboard renderer, cleared when the window closes. No persistence, no new `~/.bean` files. |
| Where new logic lives | A new pure, dependency-injected `converse()` in `@bean/core` (Approach A), with its OpenAI adapter confined to `openai-chat.ts`. |
| Persona/system prompt | Fixed default system prompt for SP2; customization is SP5's job. |
| Model | Reuse `cfg.model` and the existing API key for both router and converse. |
| Concurrency | One run at a time, as today. |

## 3. Scope

**In scope:**
- `@bean/core`: a new `converse()` function + a `propose_run` tool abstraction, exported from `index.ts`.
- `openai-chat.ts`: a `makeOpenAIConverse`/`makeOpenAIConverseWithClient` adapter using OpenAI function-tools.
- `bean:chat` IPC + preload method + `bean.d.ts` typing; a `buildChatHandler` in `ipc.ts`.
- Chat panel: ephemeral transcript, user/Bean bubbles, editable route confirm card, run-status bubbles, a message input.
- Command bar: input that seeds `sendMessage`, dropped-URL chip.
- Title-bar orb reflects activity (working during chat/run, settling to idle).
- Confirm fires the existing `bean:run`/`runOpencode` (unchanged); run status reflected in chat via the existing `onRunEvent`.

**Out of scope (deferred):**
- Console panel raw stdout/stderr stream restyle → SP3. In SP2, stdout/stderr `RunEvent`s are ignored by the chat; only `status` events surface. The console panel stays its SP1 placeholder.
- Persona/system-prompt customization → SP5.
- Conversation persistence, multi-run concurrency.

**Mockup reconciliation:** the mockup draws the "routes to skill/project [Confirm]" preview *inside* the command bar. Functionally the proposal is rendered as a card **in the chat thread** (per the "chat triggers routing" decision), not in the bar. The bar remains a pure input. This is an intentional, noted deviation from the static mockup.

## 4. Architecture

### 4.1 Core: `converse()` (new file `packages/core/src/converse.ts`)

Types:
- `ChatTurn = { role: "user" | "assistant"; content: string }` — the transcript the renderer maintains and sends each turn.
- `ProposedRun = RouteSuggestion` (reuse `{ skillName, projectPath, composedPrompt, confidence }`; `confidence` is set to `1` for a model-initiated proposal and is not surfaced in the card UI).
- `ConverseResult = { reply: string; proposedRun?: ProposedRun }`.
- `ConvoMsg = { role: "system" | "user" | "assistant"; content: string }` — a widened chat message (the existing `ChatMsg` in `router.ts` only allows `"system" | "user"`, so converse needs its own type to carry assistant turns; do **not** reuse `ChatMsg`).
- `ToolSpec = { name: string; description: string; parameters: object }` (JSON-schema object).
- `ToolCall = { name: string; args: unknown }`.
- `ConverseDeps = { chat: (a: { model: string; messages: ConvoMsg[]; tools: ToolSpec[] }) => Promise<{ content: string; toolCalls: ToolCall[] }>; model: string }`.

`converse(history: ChatTurn[], latestUserText: string, skills: Skill[], projects: Project[], deps: ConverseDeps, droppedUrl?: string): Promise<ConverseResult>`:
1. Build `ConvoMsg[]`: a fixed default system prompt (Bean persona placeholder) + a compact skills/projects listing (same data `route()` formats via `buildMessages`) + `history` (mapped `ChatTurn` → `ConvoMsg`) + the new user turn.
2. Define one tool `propose_run` with params `{ skill: string, project: string, instruction: string }` (skill/project described as "must be one of the listed names/paths").
3. Call `deps.chat({ model, messages, tools: [propose_run] })`.
4. If a `propose_run` tool call is returned, validate `args.skill` against known skill names and `args.project` against known project paths (defensive, mirroring `route()`): on an unknown skill or project, return `{ reply: content }` with **no** proposal. On a valid call, `composePrompt(skill, instruction, droppedUrl)` and return `{ reply: content, proposedRun: { skillName, projectPath, composedPrompt, confidence: 1 } }`.
5. Never throws: any error from `deps.chat` or arg parsing yields `{ reply: <fallback text> }` with no proposal, matching `route()`'s never-throw contract.

Purity: stateless and dependency-injected — the renderer owns the transcript; core transforms `(history + message) → result`. No Electron. Testable with a fake `deps.chat`.

### 4.2 OpenAI adapter (`openai-chat.ts`)

- `makeOpenAIConverseWithClient(client): ConverseDeps["chat"]` — maps `tools` to OpenAI's `{ type: "function", function: { name, description, parameters } }`, sends with `tool_choice: "auto"`, reads `choices[0].message`: returns `content ?? ""` plus `message.tool_calls` mapped to `ToolCall[]`, parsing each `function.arguments` JSON string into `args`. A malformed arguments blob is skipped (no tool call), never throws.
- `makeOpenAIConverse(apiKey): ConverseDeps["chat"]` — constructs the real `OpenAI` client (same pattern as `makeOpenAIChat`).
- The file's `ChatClient` interface is extended (or a sibling interface added) to describe `tools` in the request and `tool_calls` in the response, so the test fake stays type-checked.
- OpenAI SDK usage stays confined to this file.

### 4.3 IPC + preload

- `channels.ts`: add `IPC.chat = "bean:chat"`.
- `ipc.ts`: `buildChatHandler(deps)` — loads skills + projects (like `buildRouteHandler`) and calls `converse(...)`. `RegisterDeps` gains `converse: ConverseDeps["chat"]` (the model is already present as `deps.model`). Register `ipcMain.handle(IPC.chat, ...)`.
- `preload.ts`: `chat: (req) => ipcRenderer.invoke(IPC.chat, req)`.
- `bean.d.ts`: add `chat(req: { history: ChatTurn[]; message: string; droppedUrl?: string }): Promise<ConverseResult>`.
- `main.ts`: build `converse: makeOpenAIConverse(cfg.openaiApiKey)` and pass into `registerIpc`.
- `ChatRequest = { history: ChatTurn[]; message: string; droppedUrl?: string }` and `ConverseResult` are imported from `@bean/core` on both sides.

### 4.4 Renderer (dashboard)

- `App` owns ephemeral state: `items: ChatItem[]`, `busy: boolean`, `activity: OrbState`.
- `ChatItem` (renderer-local union): `{ kind: "user"; text }` | `{ kind: "reply"; text }` | `{ kind: "proposal"; id; run: ProposedRun; state: "pending" | "confirmed" | "cancelled" }` | `{ kind: "status"; text; tone: "info" | "done" | "error" }`.
- `sendMessage(text)` (shared by ChatPanel input + CommandBar input): push a `user` item; set `busy`/`activity=working`; build `history` from prior user/reply items; call `window.bean.chat({ history, message: text, droppedUrl })`; push a `reply` item; if `proposedRun`, push a `proposal` item; clear `droppedUrl`; `activity=idle`.
- Proposal card: shows `skill · <name>` / `project · <path>` and an editable `<textarea>` prefilled with `composedPrompt`, plus Confirm / Cancel. Confirm → `window.bean.run({ ...run, composedPrompt: editedText })`, mark card `confirmed`, `activity=working`. Cancel → mark `cancelled`.
- A single `window.bean.onRunEvent` subscription (registered once in `App`): on `status` running → push `status` "Spinning up…" (info); done → "Done" (done), `activity=done` then idle; failed → error bubble with `message`. `stdout`/`stderr` events are ignored in SP2.
- CommandBar: renders the dropped-URL chip from `App`'s `droppedUrl`; its input calls `sendMessage`.
- TitleBar receives `activity` and calls the orb's `setState`.

## 5. Error handling

- Missing/invalid API key: `converse()`'s `deps.chat` call fails → `converse` returns a fallback reply (e.g. "I couldn't reach the model — check your API key in ~/.bean/config.json."). The startup error dialog from SP1/MVP still fires separately.
- Model returns an unknown skill/project in the tool call → no card, reply preserved.
- `run()` failure → existing `status: "failed"` event → error bubble carrying `message`.
- `converse()` never throws; the IPC handler therefore never rejects for model-side issues.

## 6. Testing

**Core (`__test__/converse.test.ts`), fake `deps.chat`:**
- Plain reply, no tool call → `{ reply, proposedRun: undefined }`.
- Valid `propose_run` call → `proposedRun.composedPrompt` contains the skill body + instruction; `skillName`/`projectPath` match.
- Tool call naming an unknown skill or project → no `proposedRun`, `reply` preserved.
- `deps.chat` throws → fallback reply, function does not throw.

**Core (`__test__/openai-chat.test.ts` or extend existing), fake client:**
- Client returns content + one `tool_calls` entry with JSON `arguments` → mapped to `{ content, toolCalls: [{ name, args }] }`.
- Malformed `arguments` string → that tool call is skipped, no throw.

**App (`__test__/ipc.test.ts`, extend):**
- `buildChatHandler` wires `loadSkills`/`loadProjects` + `converse` and returns the result (mirrors the existing route-handler test).

**Renderer:** no automated DOM tests (SP1 constraint — no DOM test infra). Verified manually via `pnpm dev`.

**Gate:** `pnpm test && pnpm typecheck` from the repo root must both exit 0 before done.

## 7. Manual verification checklist (for the plan's final task)

- Open dashboard, type a chit-chat message in the chat input → Bean replies, no card.
- Type a work request ("review the PRs in the api project") → Bean replies and a confirm card appears with a skill, project, and editable prompt.
- Edit the prompt, Confirm → a "Spinning up…" bubble appears, then "Done"/failure; the title-bar orb animates working then settles.
- Cancel a card → no run fires, card shows cancelled.
- Type in the command bar (not the chat input) → same flow; message appears as a user bubble in chat.
- Drop a URL on the avatar → dashboard opens, command bar shows the URL chip, next send includes it as context.
- With an empty/invalid API key → sending a message yields the graceful fallback reply rather than a hang or crash.

## 8. Risks / open questions

- The default system prompt is a placeholder; SP5 (persona) will make it configurable. Keep it in one obvious constant so SP5 can lift it out.
- `propose_run` **enum-constrains** `skill` and `project` to the exact known skill names / project paths (built per-call in `proposeRunTool()`), on top of the defensive core validation. This was applied during SP2 review after real `gpt-5-mini` runs intermittently returned a project display label / bare name instead of the exact path, which the strict `p.path === args.project` check silently dropped — killing the confirm card. When no skills or projects exist, no tool is offered (an empty enum is an invalid schema). Further hardening (fuzzy name↔path reconciliation) remains a possible future step if enums prove insufficient.
