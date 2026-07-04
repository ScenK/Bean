# Bean — Desktop Pet Orchestrator — Design (MVP)

Date: 2026-06-30
Status: Approved for planning

## 1. Summary

Bean is a desktop "pet" that is really a **quick-launch orchestrator for coding-agent
runs**. It removes the friction of: open terminal → `cd` to a project → launch
`opencode` → load the right skill. Instead, you drop context (e.g. a Jira URL) onto a
floating avatar, type a loose instruction, and Bean's router picks the right skill and
project, shows you its plan to confirm, then fires an `opencode` subprocess and streams
the output.

The avatar is the always-present UI shell. The actual reasoning is done by the real
`opencode` CLI (Bean is a launcher/wrapper, not its own agent loop). OpenAI is used only
as a **router** that maps loose input to `{ skill, project, prompt }`.

## 2. Goals (MVP)

- Floating, draggable, always-on-top avatar that accepts dropped URLs and click-to-open input.
- A central **skill library** (markdown files) replacing today's scattered per-project skills.
- A **project registry** so the router has concrete targets to match against.
- An OpenAI **router** that suggests `{ skill, project, composedPrompt }` from loose input.
- A **confirm step** where that suggestion is fully editable before anything runs.
- A **runner** that spawns `opencode run "<prompt>" --dir <projectPath>` and streams output.
- A per-run **console window** showing live output and final status (done/failed).
- Tests from day one, monorepo tooling, latest deps.

## 3. Non-Goals (explicitly deferred)

Named here so they don't creep into the MVP:

- Pet animation / idle / working visual states (v1 avatar is a static image).
- Concurrent runs (v1 runs one at a time).
- In-app skill editor / in-app project editor (edit files in your own editor for v1).
- OpenAI conversational chat / persona.
- Skill-files-on-disk injection into projects (the "A" approach). v1 uses inline prompts ("B").
- Router auto-firing without confirmation.

## 4. Key Decisions

| Decision | Choice | Why |
|---|---|---|
| Who runs the agent loop | `opencode` CLI subprocess | Existing skills/setup work as-is; Bean is a wrapper. |
| Role of OpenAI | Router only | Maps loose input → skill + project + prompt. |
| Skill → run delivery | Inline composed prompt ("B") | Simplest; touches nothing in the project. Revisit if skills need sibling files. |
| Project targeting | Explicit registry ("A") | Gives router concrete matches; doubles as recent-launch list. |
| After router decides | Confirm-first ("A") | One click prevents aiming a destructive run at the wrong repo. |
| Output viewing | In-app console window per run ("A") | Bean can see when a run finishes and what it produced. |
| Pet form factor | Static draggable avatar ("A") | Delivers drag-and-drop now; animation later. |
| Skill storage | `~/.bean/skills/*.md` folder ("A") | The folder is the database; edit in your real editor. |

## 5. Architecture

**Stack:** Electron + TypeScript (strict). Main process owns all real work (OpenAI calls,
subprocess spawning, file/config I/O). Renderer windows are UI only, talking to main over IPC.

### Windows

1. **Avatar** — small, frameless, always-on-top, draggable. Static image. URL drop target. Click → Intake.
2. **Intake** — text box + any dropped URL prefilled. Submit triggers the router.
3. **Console** — one per run. Scrollable streaming log + status. Hosts the Confirm step (modal/section) before the run fires.

### Main-process modules (in `core`)

- **Router** — `{ userText, droppedUrl }` + skill descriptions + project registry → OpenAI → `{ skillName, projectPath, composedPrompt, confidence }`.
- **Runner** — spawns `opencode run "<composedPrompt>" --dir <projectPath>`; streams stdout/stderr to Console; tracks exit status. One run at a time for v1. <!-- ponytail: defer concurrency until two runs are actually needed -->
- **SkillLibrary** — reads `~/.bean/skills/*.md`; parses name + description (frontmatter or first heading) + body.
- **ProjectRegistry** — reads/writes `[{ name, path, defaultSkill? }]`.
- **Config** — OpenAI API key, model name, paths.

## 6. Data Flow & Run Lifecycle

```
Drop Jira URL on Avatar ──► Intake opens (URL prefilled)
        │
        ▼
You type instruction ──► main: Router
        │                   ├─ load skill descriptions (SkillLibrary)
        │                   ├─ load projects (ProjectRegistry)
        │                   └─ OpenAI call → { skill, project, composedPrompt, confidence }
        ▼
Confirm view: "Run `review-code` on `acme`?  [prompt, editable]"
        │           ├─ Cancel → done
        │           └─ Edit skill / project / prompt
        ▼
Confirm ──► main: Runner
              spawn `opencode run "<composedPrompt>" --dir <project.path>`
              │
              ▼
        Console window streams stdout/stderr ──► exit code → status: done / failed
```

- Router output is a **suggestion**, fully editable at Confirm (skill, project, and prompt).
- **Composed prompt** = chosen skill's markdown body + your instruction + dropped URL, concatenated.
- Low confidence / no project match → Confirm opens with best-guess or empty dropdowns; never silently fires a wrong guess.
- **Failure handling:** spawn errors, non-zero exit, and missing `opencode` binary on PATH all surface as a clear Console status + message — no silent hang.

## 7. Storage

All under `~/.bean/`:

- `skills/*.md` — skill library. Each file: name + short description (router reads these) + body (used in prompts).
- `projects.json` — `[{ name, path, defaultSkill? }]`. Hand-edited for v1. <!-- ponytail: in-app editor later -->
- `config.json` — OpenAI API key, model name, paths. Lives here (outside the repo), not committed.

## 8. Monorepo Layout & Tooling

pnpm workspaces + Turbo. Node 24. Latest TypeScript + ESBuild. (A monorepo is heavier than
a single app strictly needs, but it gives clean, independently-testable package boundaries —
explicitly requested.)

```
bean/
  package.json            # workspace root, turbo scripts
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  packages/
    core/                 # Router, Runner, SkillLibrary, ProjectRegistry, Config
      src/  __test__/     # pure logic, zero Electron deps — headless-testable
    app/                  # Electron main + preload + renderer (3 windows)
      src/  __test__/
```

- **`core`** — all logic, no Electron deps, fully unit-testable.
- **`app`** — thin Electron shell wiring `core` to the windows.
- **Build:** ESBuild per package, orchestrated by Turbo. TypeScript strict.
- **Tests:** Vitest (latest; native ESM/TS). Tests in `__test__/` folders, separate from source. <!-- ponytail: one runner, not Jest+ts-jest sprawl -->

### Day-one test coverage (money paths)

- Prompt composition (skill body + instruction + URL).
- Skill markdown parsing (name/description/body).
- Router output **shape** (OpenAI mocked — no live calls in tests).
- ProjectRegistry read/write round-trip.
- Runner status mapping (success / non-zero exit / spawn error / missing binary), with the spawn boundary mocked.

## 9. Risks / Open Questions

- VERIFIED: opencode passes the message as a positional arg (`opencode run "<msg>"`); `--dir` sets the project directory; `--format json` is available if structured parsing is ever needed. `-p` is `--password`, not prompt.
- Inline-prompt approach ("B") breaks for skills that reference sibling files/scripts; upgrade path is the "A" injection approach, deferred.
- Router quality depends on good skill descriptions; the Confirm step is the safety net.
