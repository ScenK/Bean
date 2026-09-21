# Theme colors carry a WCAG budget

Renderer colors that land on a surface or on an accent fill go through a `--bean-*` token in
`packages/app/src/renderer/theme.css`, and each token has a contrast job it must keep:

- text tokens (`--bean-text`, `--bean-text-dim`, `--bean-accent-text`, `--bean-link`,
  `--bean-error`, `--bean-orb-check-ink`) — **4.5:1 against all three surfaces** (`--bean-bg`, `--bean-surface`,
  `--bean-surface-2`), because panels put the same text on all of them;
- graphic tokens (`--bean-star`, `--bean-control-border`) — **3:1** (WCAG 1.4.11);
- `--bean-accent-ink` on an `--bean-accent` fill — 4.5:1 (buttons, selected rows, chips).

The accent is **three tokens with three jobs**, and mixing them is the mistake to avoid:
`--bean-accent` is the fill (hearth keeps its original bright amber, which is only 2.4:1 as
text — never use it as ink on a surface); `--bean-accent-text` is that accent darkened for ink
and lines on a surface; `--bean-accent-ink` is what reads *on* the fill.

**Accepted exception — don't "fix" it:** in hearth the fill is the original amber under white
ink, 3.3:1, below AA. Both a darker fill and a dark ink were tried and rejected on sight; the
light theme's look is the product decision and it outranks the number here. The guards encode
it, they don't ignore it: the token test holds hearth's ink-on-fill to 3:1 (graphite still owes
4.5:1), and the DOM scan holds any text painted in `--bean-accent-ink` to 3:1, so a regression
past *that* still fails. An accent-filled button is likewise 2.4:1 against the page.

Everything around the fill still pays full freight, which is why `--bean-accent-text` exists —
a link or label is not a fill. Text on an `--bean-accent-ink` fill (the inverted badges) uses
`--bean-accent-text` too, since that ink is white in hearth.

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
