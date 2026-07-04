# Bean — Dashboard Redesign, Sub-Project 5: Persona Panel — Design

Date: 2026-06-30
Status: Approved for planning
Depends on: [2026-06-30-bean-command-bar-chat-design.md](2026-06-30-bean-command-bar-chat-design.md) (SP2, complete — `converse()` is what this SP changes)
Roadmap: [.memory/project-dashboard-redesign-roadmap.md](../../../.memory/project-dashboard-redesign-roadmap.md)

## 1. Summary

Turn the placeholder Persona panel into an editable surface for Bean's name and tone, and
lift the hardcoded `DEFAULT_SYSTEM_PROMPT` out of `packages/core/src/converse.ts` into a real,
user-configurable `Persona`. Today the system prompt sent to the model is a single frozen
string; after this SP it's composed from a `Persona` (`{ name, tags }`) that the user edits in
the dashboard and that persists to `~/.bean/persona.json`, read fresh on every chat turn.

The mockup's open decision — editable vs. decorative — resolves to **editable**: the ledger
explicitly frames this SP as lifting the constant into "configurable persona," which a
decorative-only panel would not deliver.

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Editable vs. decorative | Editable — name (free text) + tone (multi-select preset tags). |
| Tone input shape | Fixed preset tag set (`Warm`, `Concise`, `Direct`, `Playful`, `Formal`, `Encouraging`), not free text — composes deterministically into the prompt. |
| Sample-voice line | Static, hardcoded, identical for every persona — decorative flavor only, no LLM call, not persisted. |
| Persistence | New `~/.bean/persona.json`, own core module (`persona-store.ts`), following `project-registry.ts`'s load-degrades / save-validates split — not folded into `config.json`. |
| Name scope | Only changes the system prompt's `You are {name}...` line. Title bar text and chat/command-bar placeholders stay static "Bean" UI chrome — out of scope. |
| Prompt composition | Generic template (`You are {name}, a {tags} desktop coding companion. Reply in a way that reflects that.`) rather than a per-tag phrase table — one deterministic function, no bespoke wording to maintain per tag. |
| Live update scope | No broadcast needed — `buildChatHandler` loads persona fresh per chat call; only the Persona panel itself reads it elsewhere. |
| Browser-safe export | `PERSONA_TAGS`/`Persona`/`PersonaTag`/`DEFAULT_PERSONA`/`composePersonaPrompt` live in a new pure `persona.ts` (zero Node imports), separate from the Node-only `persona-store.ts`, and get a `@bean/core/persona` subpath export — mirrors the `@bean/core/terminal` split SP3 introduced. The renderer needs `PERSONA_TAGS` as a runtime value (to render all six chips in edit mode), and a value import from the main `@bean/core` barrel would drag `node:fs`-using modules into the `platform: "browser"` esbuild bundle, which fails the same way SP3's terminal reducer did before that fix. |

## 3. Scope

**In scope:**
- `@bean/core`: new pure `persona.ts` (`PERSONA_TAGS`, `PersonaTag`, `Persona`,
  `DEFAULT_PERSONA`, `composePersonaPrompt`) exposed via a new `@bean/core/persona` subpath
  export in `package.json`; new Node-only `persona-store.ts` (`loadPersona`, `savePersona`);
  `personaFile(dir)` helper in `config.ts`; `converse.ts` keeps a fixed
  `BEHAVIOR_INSTRUCTIONS` constant and imports `composePersonaPrompt` from `persona.ts`, with
  `converse()` taking a required `persona` parameter.
- New IPC channels `getPersona` / `savePersona` — definitions in `channels.ts`, handlers in
  `ipc.ts`, wiring in `main.ts`, exposure in `preload.ts` + `bean.d.ts`. `buildChatHandler`
  gains a `loadPersona`/`personaFile` dep and passes the loaded persona into `converse()`.
- `PersonaPanel`: stateful — fetches persona on mount, view/edit modes matching
  `SkillsPanel`'s pattern (name + tag chips display, edit form with Save/Cancel).
- CSS for the tag-chip toggle UI (selected/unselected states) and edit-mode name input,
  reusing existing `.bean-chip`/`.bean-btn` primitives.

**Out of scope (deferred):**
- Relabeling title bar / placeholders / any other "Bean"-branded UI chrome from the persona
  name — see Key decisions.
- Free-text tone or a raw-system-prompt override textarea — the preset-tag set is the only
  tone input.
- Making the sample-voice line reflect the selected tags — it's a fixed decorative string.
- Any cross-window live-update/broadcast of persona changes — not needed since only the
  chat path consumes it, and that path reloads fresh per call.
- Persona presets/profiles (save multiple named personas, switch between them) — single
  current persona only, same shape as the theme setting.

## 4. Architecture

### 4.1 Core: pure `persona.ts` (packages/core/src/persona.ts)

Everything the renderer needs at runtime, plus the prompt composer, lives in one
zero-Node-import file — no `node:fs`, no `node:path`. This mirrors `terminal.ts`'s split from
SP3: the renderer bundles with `platform: "browser"` and cannot resolve `node:*` imports, so
anything a browser bundle needs as a **value** (not just a type) must live in a module with no
transitive Node dependency, reachable via its own `package.json` subpath rather than the main
`@bean/core` barrel (which re-exports `config.js`/`skill-library.js`/etc., all Node-only).

```ts
export const PERSONA_TAGS = ["Warm", "Concise", "Direct", "Playful", "Formal", "Encouraging"] as const;
export type PersonaTag = typeof PERSONA_TAGS[number];

export interface Persona {
  name: string;
  tags: PersonaTag[];
}

export const DEFAULT_PERSONA: Persona = { name: "Bean", tags: ["Warm", "Concise", "Direct"] };

export function isValidPersona(v: unknown): v is Persona {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim() === "") return false;
  if (!Array.isArray(p.tags) || p.tags.length === 0) return false;
  return p.tags.every((t) => (PERSONA_TAGS as readonly string[]).includes(t as PersonaTag));
}

export function composePersonaPrompt(persona: Persona): string {
  const tags = persona.tags.map((t) => t.toLowerCase()).join(", ");
  return `You are ${persona.name}, a ${tags} desktop coding companion. Reply in a way that reflects that.`;
}
```

`package.json` (packages/core) gains a subpath export alongside the existing `./terminal` one:
```json
"./persona": {
  "types": "./dist/persona.d.ts",
  "default": "./dist/persona.js"
}
```

`index.ts` gains `export * from "./persona.js";` so main-process code (`ipc.ts`, `main.ts`,
tests) can keep importing from the plain `@bean/core` barrel as usual — the subpath only
matters for the browser-bundled renderer.

### 4.2 Core: `persona-store.ts` (packages/core/src/persona-store.ts)

The Node-only I/O half — mirrors `project-registry.ts`'s load-degrades / save-validates split:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PERSONA, isValidPersona, type Persona } from "./persona.js";

export async function loadPersona(file: string): Promise<Persona> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return isValidPersona(parsed) ? parsed : DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
}

export async function savePersona(file: string, persona: Persona): Promise<void> {
  if (!isValidPersona(persona)) throw new Error("invalid persona: name and at least one tag are required");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(persona, null, 2) + "\n", "utf8");
}
```

`loadPersona` never throws (missing/corrupt file degrades to `DEFAULT_PERSONA`, same failure
mode as `loadProjects`) — a broken persona file must never block the chat path. `savePersona`
does validate and throw, matching `saveSkill`'s callee-side guard precedent: the UI's own
validation is not the only line of defense.

`config.ts` gains:
```ts
export function personaFile(dir: string): string { return join(dir, "persona.json"); }
```

### 4.3 Core: `converse.ts` prompt lift

Replace `DEFAULT_SYSTEM_PROMPT` with a fixed behavior constant, and import the persona intro
from `persona.ts` instead of composing it locally:

```ts
import { composePersonaPrompt, type Persona } from "./persona.js";

const BEHAVIOR_INSTRUCTIONS =
  "You cannot do work yourself — a separate `opencode` process does. When the user wants " +
  "a concrete task done in one of their projects, call the propose_run tool with the best " +
  "matching skill name, project path, and a clear instruction; otherwise just reply in text. " +
  "Only propose a run when the user clearly wants work done.";
```

> **Update 2026-07-03:** `BEHAVIOR_INSTRUCTIONS` gains one sentence to stop Bean reciting its
> full skill/project catalog unprompted in replies (the model was treating the `catalog()`
> block as something to volunteer, producing long "here's everything I can do" responses):
> `"The skills/projects list below is for your own routing decisions — don't recite or "` +
> `"summarize it unprompted. Only describe your skills or projects if the user directly asks "` +
> `"what you can do."` — appended after the existing text, same constant, no signature or
> behavior change beyond the model's reply style. `converse.test.ts` gains a case asserting
> the new sentence is present in the composed system prompt.

`converse()`'s signature gains a `persona` parameter, inserted after `projects` (grouped with
the other catalog-shaping inputs, before `deps`):

```ts
export async function converse(
  history: ChatTurn[],
  latestUserText: string,
  skills: Skill[],
  projects: Project[],
  persona: Persona,
  deps: ConverseDeps,
  droppedUrl?: string,
): Promise<ConverseResult> {
  const messages: ConvoMsg[] = [
    { role: "system", content: `${composePersonaPrompt(persona)}\n\n${BEHAVIOR_INSTRUCTIONS}\n\n${catalog(skills, projects)}` },
    ...
```

This is a breaking signature change to an exported function — every call site (`ipc.ts`'s
`buildChatHandler`, existing `converse.test.ts` cases) is updated in the same change, not left
compatible via an optional parameter. `DEFAULT_PERSONA` (from `persona.ts`) is what existing
tests pass to reproduce prior behavior in spirit — the exact wording changes (see §8), which
is the intended effect of this SP.

### 4.4 IPC surface

`channels.ts` — add to `IPC`:
```ts
getPersona: "bean:get-persona",
savePersona: "bean:save-persona",
```

`ipc.ts` — new handler builders, following the theme get/set shape (single value, not a list):

```ts
export interface PersonaHandlerDeps {
  loadPersona: (file: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
}

export function buildPersonaHandlers(deps: PersonaHandlerDeps) {
  return {
    get: (): Promise<Persona> => deps.loadPersona(deps.personaFile),
    save: (persona: Persona): Promise<void> => deps.savePersona(deps.personaFile, persona),
  };
}
```

```ts
const persona = buildPersonaHandlers(deps);
ipcMain.handle(IPC.getPersona, () => persona.get());
ipcMain.handle(IPC.savePersona, (_e, p: Persona) => persona.save(p));
```

`ChatHandlerDeps` gains `loadPersona`/`personaFile` (same shape as `PersonaHandlerDeps`'s
fields); `buildChatHandler` loads persona alongside skills/projects and passes it to
`converse()`:

```ts
export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects, persona] = await Promise.all([
      deps.loadSkills(deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile),
    ]);
    return converse(req.history, req.message, skills, projects, persona, { chat: deps.converse, model: deps.model }, req.droppedUrl);
  };
}
```

`RegisterDeps` picks up the union of `PersonaHandlerDeps` fields; `main.ts` passes
`loadPersona`/`savePersona` (from `@bean/core`) and `personaFile(dir)`, same import style as
`loadSkills`/`saveSkill`.

`preload.ts` / `bean.d.ts` — add:
```ts
getPersona(): Promise<Persona>;
savePersona(p: Persona): Promise<void>;
```

### 4.5 Renderer: `PersonaPanel` (packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx)

No props needed — self-contained, unlike `SkillsPanel` (no cross-panel action).

```ts
import { PERSONA_TAGS, type Persona, type PersonaTag } from "@bean/core/persona";
```

`PERSONA_TAGS` is imported as a runtime value from the `@bean/core/persona` subpath (§4.1) —
not the main `@bean/core` specifier, which would pull Node-only modules into the browser
bundle. `Persona`/`PersonaTag` are `import type`, so their source subpath doesn't affect
bundling either way, but importing them from the same subpath keeps one import line instead of
two.

State:
- `persona: Persona | undefined` — fetched via `window.bean.getPersona()` in a mount
  `useEffect`; `undefined` while loading.
- `mode: "view" | "edit"`.
- `draftName: string`, `draftTags: PersonaTag[]` — only populated when entering edit mode.
- `saveError: string | undefined`.

Behavior:
- **View mode**: renders `persona.name`, one chip per entry in `persona.tags` only (not the
  full six-preset `PERSONA_TAGS` set — view mode shows just the persona's own tags, matching
  the mockup), the fixed sample-voice line, and an `Edit` button.
- **Edit button**: `mode = "edit"`, `draftName = persona.name`, `draftTags = [...persona.tags]`,
  `saveError = undefined`.
- **Edit mode**: a text input bound to `draftName`; one toggle-able chip button per
  `PERSONA_TAGS` entry (all six shown, `--selected` reflecting membership in `draftTags`,
  click adds/removes — removing the last selected tag is a no-op, not an error state, so the
  UI can never reach an empty-tags draft); `Save`/`Cancel` buttons; `saveError` line if set.
- **Save**: `await window.bean.savePersona({ name: draftName.trim(), tags: draftTags })`; on
  success refetch `getPersona()`, `mode = "view"`; on rejection (e.g. empty trimmed name — the
  UI doesn't pre-block an empty name field, it relies on the core validation and surfaces the
  resulting error) set `saveError` and stay in edit mode with the draft intact.
- **Cancel**: `mode = "view"`, discard draft, clear `saveError`.
- Empty/loading state (`persona === undefined`): reuse `.bean-panel-empty` briefly — this
  resolves near-instantly since `persona-store.ts` always returns a value (default or
  loaded), never an empty/missing state to render specially.

### 4.6 CSS (packages/app/src/renderer/dashboard.css)

Add: chip toggle styling (selected vs. unselected, matching the mockup's filled-vs-outlined
distinction), a labeled name input for edit mode, and the italic sample-voice line style.
Reuse `.bean-chip`/`.bean-btn`/`.bean-btn--ghost` primitives; follow existing `.bean-*` naming
and SP1 theme-variable conventions.

## 5. Error handling

- `getPersona` never fails from the panel's perspective — `loadPersona` always resolves (to
  `DEFAULT_PERSONA` on any read/parse failure).
- `savePersona` rejecting (validation failure, disk error) → inline error under the edit form,
  draft preserved, user can fix and retry Save or Cancel to discard.
- A corrupt `~/.bean/persona.json` written by something other than this panel → next
  `loadPersona` silently falls back to `DEFAULT_PERSONA` rather than surfacing a parse error;
  consistent with how `loadProjects`/`loadConfig`'s non-throwing paths already behave elsewhere
  in the codebase.

## 6. Testing

**Core (`packages/core/__test__/persona-store.test.ts`, new file):** imports `loadPersona`/
`savePersona` from `../src/persona-store.js` and `DEFAULT_PERSONA`/`PERSONA_TAGS` from
`../src/persona.js` (persona-store.ts does not re-export persona.ts's members).
- `loadPersona` returns `DEFAULT_PERSONA` when the file doesn't exist.
- `loadPersona` returns `DEFAULT_PERSONA` when the file contains invalid JSON.
- `loadPersona` returns `DEFAULT_PERSONA` when the parsed value fails validation (empty name,
  empty tags, unknown tag value).
- `loadPersona` returns the parsed persona when valid.
- `savePersona` writes the file and a subsequent `loadPersona` round-trips the exact value.
- `savePersona` creates the parent directory if it doesn't exist yet.
- `savePersona` rejects an empty/whitespace-only name.
- `savePersona` rejects an empty tags array.
- `savePersona` rejects a tag not in `PERSONA_TAGS`.

**Core (`packages/core/__test__/converse.test.ts`, extending the existing file):** imports
`composePersonaPrompt`/`DEFAULT_PERSONA` from `../src/persona.js`.
- `composePersonaPrompt(DEFAULT_PERSONA)` produces the expected sentence.
- `composePersonaPrompt` with a different name/tag combination reflects both in the output.
- `converse()`'s system-message content includes the composed persona prompt, the fixed
  `BEHAVIOR_INSTRUCTIONS` text, and the skills/projects catalog, in that order.
- Existing `converse()` test cases updated to pass a persona argument (using
  `DEFAULT_PERSONA` where the prior tests didn't care about wording).

**IPC (`packages/app/__test__/ipc.test.ts`, extending the existing file):**
- `getPersona` handler calls `deps.loadPersona(deps.personaFile)` and returns its result.
- `savePersona` handler calls `deps.savePersona(deps.personaFile, persona)` with the given
  argument.
- `buildChatHandler` loads persona alongside skills/projects and passes it as `converse()`'s
  fourth argument (positionally: after `projects`, before `deps`).

**Renderer:** no automated DOM tests (SP1–SP4 constraint — no DOM test infra). Verified
manually via `pnpm dev` per the checklist below.

**Gate:** `pnpm test && pnpm typecheck` from the repo root must both exit 0 before done.

## 7. Manual verification checklist (for the plan's final task)

- Open the dashboard with no `~/.bean/persona.json` present → Persona panel shows name
  "Bean", exactly the three default tags (`Warm`, `Concise`, `Direct`) as chips, and the
  fixed sample-voice line.
- Click `Edit` → name input pre-filled "Bean", all six tag chips shown, the three defaults
  pre-selected.
- Change the name, toggle a tag off and another on, click `Save` → panel returns to view mode
  reflecting the new name and tags; `~/.bean/persona.json` now exists on disk with that exact
  content.
- Reopen/reload the dashboard → the saved persona (not the default) is what loads.
- Click `Edit`, clear the name field entirely, click `Save` → an inline error appears, the
  edit form stays open with the (empty) draft intact, no file is written/overwritten.
- Click `Edit`, deselect tags down to the last one, then click that last selected tag again →
  it stays selected (the click is a no-op) — the draft can never reach zero tags.
- Click `Edit`, make changes, click `Cancel` → the file on disk and the view-mode display are
  unchanged.
- Send a chat message after changing the persona name/tags → no manual way to inspect the raw
  system prompt without model/logging access, so this step is verified structurally (the unit
  tests above cover `composePersonaPrompt`/`converse()` composition) rather than by observing
  live model output; note this limitation in the review report if a real API key isn't
  available in the verifying environment.
- Toggle Hearth/Graphite → the panel restyles like other panels.

## 8. Risks / open questions

- **System prompt wording changes for everyone, immediately:** the default persona's composed
  prompt ("You are Bean, a warm, concise, direct desktop coding companion. Reply in a way
  that reflects that.") is not byte-identical to the old `DEFAULT_SYSTEM_PROMPT`'s "a warm,
  concise desktop coding companion. Reply briefly and directly." wording. This is the
  intended effect of the SP (lifting a frozen string into a generic, tag-driven template
  necessarily changes its exact phrasing) rather than a regression, but it does mean existing
  conversational tone shifts slightly even for users who never touch the Persona panel. Worth
  a memory note if it turns out to meaningfully change model behavior in practice.
- **No persona reset-to-default affordance:** if a user edits away from the default and wants
  it back, they either re-enter "Bean" + the three original tags manually or delete
  `~/.bean/persona.json` outside the app. Acceptable for a first pass; add a "Reset" button
  later if this proves annoying.
- **Tag set is fixed at six presets:** adding a new tone tag later requires a code change
  (`PERSONA_TAGS`), not a data change. Consistent with treating tone as a small, curated
  vocabulary rather than open-ended free text — the earlier design decision this SP is built
  on.
</content>
