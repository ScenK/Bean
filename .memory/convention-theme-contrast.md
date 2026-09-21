# Theme colors carry a WCAG budget

Renderer colors that land on a surface or on an accent fill go through a `--bean-*` token in
`packages/app/src/renderer/theme.css`, and each token has a contrast job it must keep:

- text tokens (`--bean-text`, `--bean-text-dim`, `--bean-accent`, `--bean-link`, `--bean-error`,
  `--bean-orb-check-ink`) — **4.5:1 against all three surfaces** (`--bean-bg`, `--bean-surface`,
  `--bean-surface-2`), because panels put the same text on all of them;
- graphic tokens (`--bean-star`, `--bean-control-border`) — **3:1** (WCAG 1.4.11);
- `--bean-accent-ink` on an `--bean-accent` fill — 4.5:1 (buttons, selected rows, chips).

`--bean-control-border` exists because `--bean-border` is a *separator* tone (1:1 with the page
in hearth). A control whose only cue is a colored track (the skills/routines toggles) uses
`--bean-control-border`; cards and dividers keep `--bean-border`.

Don't hardcode a theme-dependent color in `shared.css` — a literal tuned for one theme silently
fails in the other (that's how `#e5484d` errors and an `oklch(0.55 0.1 48)` input color got in).
A literal is only fine when it is self-contained: a fixed fill plus its own ink, contrast-checked
once and identical in both themes (the "YOURS" badge green). Anything that lands on a surface or
an accent fill takes the per-theme token.

Two more traps the audit hit:
- `opacity` is not a dim tone. `opacity: 0.6` on body text reads 3.8:1 in hearth; use
  `--bean-text-dim`. Opacity is fine for `:disabled` (WCAG exempts inactive controls) and for
  hover-revealed controls.
- a translucent veil over a fill is its own backdrop — `rgba(255,255,255,0.22)` over the hearth
  accent dropped white ink to 4.2:1.

Two guards, both required to stay green:
- `packages/app/__test__/theme-contrast.test.ts` — parses `theme.css` and checks the budget above
  (runs in `pnpm test`, so it gates every push).
- `packages/app/e2e/contrast.e2e.ts` — opens every component window in both themes and measures
  the real rendered DOM (canvas-resolved colors; `getComputedStyle` returns `oklch()` verbatim).
  Advisory CI job, but it catches rule-level regressions the token test can't see.
