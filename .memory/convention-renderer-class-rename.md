# Renaming a renderer CSS class: grep the whole repo, not `packages/app/src`

The Playwright e2e specs live in `packages/app/e2e/`, **outside** `src/`, and they locate
elements by the renderer's own class names (`.bean-notes-idx-title`, `.bean-skills-row`, …).
A rename that only greps `packages/app/src` looks clean, passes `pnpm test` and
`pnpm typecheck`, and then fails the full e2e run (local, or CI on `main` — pull-request CI runs
only the `@ci` tier, see [convention-e2e-tiers.md](convention-e2e-tiers.md)). `pnpm test` and
`pnpm typecheck` cannot see it, because CSS classes are neither typed nor unit-tested.

So when you rename or delete a renderer class:

```bash
grep -rn "<old-class>" --include='*.ts' --include='*.tsx' --include='*.css' . | grep -v node_modules
```

from the repo root. Same rule for deleting a class: if a spec still selects it, the assertion
silently becomes "element never appears".

Corollary for hiding an element in CSS: `visibility: hidden` and `display: none` take the node
out of the tab order, so a hover-revealed control becomes keyboard-unreachable. Hide it with
`opacity: 0` and reveal it on `:focus-visible` alongside the hover rule.

The chat sidebar's row controls are also zero-wide until the row is hovered or the control is
focused (so titles keep the row). Playwright treats a zero-size node as not visible: an e2e spec
must `row.hover()` before clicking one, or the click times out.

Related: [convention-renderer-view-prefs-in-localstorage.md](convention-renderer-view-prefs-in-localstorage.md)
