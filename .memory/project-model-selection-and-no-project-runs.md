# project: model selection + "no project" (scratch workspace) runs

`ProposalCard`/`DelegateCard` gained a model picker and a merged project/no-project menu
(design source: the Claude Design "Bean" project, `Proposal Panel.dc.html`, mockups 3a + 2a).

**Model selection (3a):** `packages/core/src/models.ts` is a hardcoded canonical-model table
(`MODELS`), each entry mapping to per-CLI alias strings (`aliases: Partial<Record<CliName,
string>>`). `resolveModelAlias(modelId, cli)` looks up the flag value; `availableModels(clis)`
annotates each with `availableOn` for the picker's dimmed rows. `launchCommand`/`delegateCommand`
append `--model <alias>` only when an alias exists for the chosen CLI — otherwise the flag is
silently omitted (that model just isn't selectable for that CLI in the UI). Last-used-per-skill
is a flat `Record<skillName, modelId>` at `~/.bean/model-memory.json`
(`loadModelMemory`/`saveModelMemory`, same swallow-errors-to-default shape as `memory/store.ts`).

**No-project runs (2a):** `RouteSuggestion.projectPath` is now **optional** — absent means
"scratch workspace," not an error. `converse()`'s `propose_run`/tool schema drops `project` from
`required` (omit ≠ enum mismatch); an explicit-but-unknown project value is still rejected.
`LaunchRequest.projectPath` stays a required **string**, with `""` as the sentinel the IPC layer
(`buildLaunchHandler` in `packages/app/src/ipc.ts`) resolves into a real path just before
`launchInTerminal` — a bare `scratchDir(beanDir)` (`packages/core/src/config.ts`), always empty.

**Bean does not fetch or clone the optional URL seed itself (deliberate, not a gap).** An
earlier version of this feature had Bean shell out to `git ls-remote`/`git clone` and `fetch()`
to classify and materialize a "no project" URL locally (`url-sniff.ts`, `scratch-workspace.ts` —
both deleted). That duplicated capability the *launched* CLI already has: opencode/claude are
full coding agents with their own shell/git/fetch access, so having Bean do it first only added
attack surface (SSRF/`file:` validation, a whole PATH-threading bug class for `git` specifically)
for a feature the agent could do itself. Current design: the optional URL box in
`ProposalCard`'s "no project" picker is purely a client-side prompt convenience — on confirm it's
folded into the composed prompt text as a `## Source` section (same pattern as the `## Task`
section for the extra-instructions box), never sent to IPC as a separate field. If you're adding
a feature that needs Bean itself to reach out to a URL/repo, ask first whether the delegated
agent should just be told to do it instead — that's almost always the right default here.

**Gotcha:** `buildLaunchHandler`'s returned function stays **synchronous** when `req.projectPath`
is already truthy (or mode is `"open"`) — it only takes the async scratch-dir-ensure detour for
`""`. Existing `ipc.test.ts`/e2e assertions that call the handler and immediately check
`spawnLaunch` depend on this; don't make the whole function unconditionally async or those break.

**Delegate does NOT support no-project** — `ProposedDelegate.projectPath` is still required.
Only the terminal-launch (`ProposalCard`/`RouteSuggestion`) path got the scratch-workspace
treatment; delegate only gained the model chip.

Reusable UI piece: `packages/app/src/renderer/shared/ChipMenu.tsx` — the first "click a chip,
get a floating popover" component in the renderer (previously all pickers were always-visible
toggle-chip rows, e.g. `.bean-skills-project-chip`). Reach for it before building another
one-off dropdown.
