---
name: safety-mac-adhoc-signing
description: Why packages/app has an afterSign hook that ad-hoc codesigns Bean.app, and what it does/doesn't fix
metadata:
  type: project
---

`packages/app/package.json`'s `build.mac` sets `"identity": null` (skip electron-builder's own
signing lookup) and `"afterSign": "scripts/after-sign.mjs"`, which runs
`codesign --force --deep --sign - Bean.app` after packaging.

**Why:** macOS refuses to *execute* an unsigned arm64 binary at all (an AMFI requirement, not a
Gatekeeper opinion). Without any signature, a downloaded `Bean.app` fails immediately with "Bean
is damaged and can't be opened" — Move to Trash / Cancel only, no Open option. An ad-hoc
signature (`--sign -`, no identity/certificate) is free and makes the binary executable again;
once executable, Gatekeeper evaluates the quarantine flag and falls back to its standard
"downloaded from the internet, open it?" prompt (Open/Cancel) since there's no Developer ID or
notarization ticket to trust further.

**How to apply:** this does NOT satisfy notarization or full Gatekeeper trust — it only clears
the "must be signed to run" bar. A real Developer ID cert + `xcrun notarytool` (paid Apple
Developer Program, $99/yr) is still required to get the fully silent "no warning" open. If you
change the mac packaging target or add electron-builder's own signing (`CSC_LINK`/env-based
identity), verify with a real `pnpm dist:mac` — `codesign -dv` should show
`flags=0x2(adhoc)` and `spctl -a -vvv -t execute` should say `accepted`, not just that tests/
typecheck pass.
