# project-website — the public site in `website/`

`website/index.html` is a single static page (inline CSS/SVG, a few lines of JS, no build step),
published to GitHub Pages at https://scenk.github.io/Bean/ by `.github/workflows/website.yml` on
every push to `main` that touches `website/`. Pages source must be "GitHub Actions" in the repo
settings. The README links to it.

- **Copy states code facts.** The Dream ledger mirrors `DREAM_MIN_HOURS`, `DREAM_MIN_NEW` and the
  `max(3, 20%)` drop cap in `core/src/memory/dream.ts`; the download cards mirror the release
  assets (`-arm64.dmg`, `Bean.Setup.*.exe`, `bean-core-*.tar.gz`). Change one, update the page.
- **Download links resolve at runtime.** Asset names carry the version, so the page asks the
  GitHub API for the latest release and fills each `data-asset` link by regex; without it the
  buttons fall back to `releases/latest`. Renaming an asset means updating the regex in the page.
- **Art is flat inline SVG** (the `#bean` symbol copies the app icon's shapes) in the Hearth and
  Graphite palettes from `renderer/theme.css`. Generated raster art was tried and rejected as too
  glossy/cartoonish — keep illustrations flat.
- Not a workspace package: no tests or typecheck cover it. Check it in a browser.
