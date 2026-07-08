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
`launchInTerminal` — either `prepareScratchWorkspace()` (shallow git clone for a repo URL, or
fetched-page text for a page URL, `packages/core/src/scratch-workspace.ts`) or a bare
`scratchDir(beanDir)` when no URL was given. `sniffUrl()` (`packages/core/src/url-sniff.ts`)
decides repo-vs-page via `git ls-remote` first, then an HTML-content-type HEAD request.

**Gotcha:** `buildLaunchHandler`'s returned function stays **synchronous** when `req.projectPath`
is already truthy (or mode is `"open"`) — it only takes the async scratch-resolution detour for
`""`. Existing `ipc.test.ts`/e2e assertions that call the handler and immediately check
`spawnLaunch` depend on this; don't make the whole function unconditionally async or those break.

**Delegate does NOT support no-project** — `ProposedDelegate.projectPath` is still required.
Only the terminal-launch (`ProposalCard`/`RouteSuggestion`) path got the scratch-workspace
treatment; delegate only gained the model chip.

Reusable UI piece: `packages/app/src/renderer/shared/ChipMenu.tsx` — the first "click a chip,
get a floating popover" component in the renderer (previously all pickers were always-visible
toggle-chip rows, e.g. `.bean-skills-project-chip`). Reach for it before building another
one-off dropdown.
