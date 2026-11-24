---
name: safety-mac-codesigning
description: How Bean.app is codesigned (self-signed cert in CI, ad-hoc locally) and why the updater must not re-sign a release
metadata:
  type: project
---

`build.mac.identity` is `null` (electron-builder never signs); `scripts/after-sign.mjs` runs
`codesign --force --deep --sign "$BEAN_SIGN_IDENTITY"` (`--keychain $BEAN_SIGN_KEYCHAIN`), or
`--sign -` (ad-hoc) when unset. The Mac installer workflow imports the self-signed cert from the
`MAC_SIGN_P12` / `MAC_SIGN_P12_PASSWORD` secrets (made once by `scripts/make-signing-cert.sh`)
into a temp keychain, fails without them, and checks the built DR contains `certificate leaf`.

**Why:** macOS refuses to run unsigned arm64 code, so some signature is mandatory. TCC (privacy
grants: App Management, Accessibility, Automation…) keys a grant on the app's designated
requirement. Ad-hoc DR = cdhash, new every build, so every update reset the grants. A fixed
cert gives `identifier "dev.scenk.bean" and certificate leaf = H"…"` — same across releases,
grants survive. The cert is untrusted (`CSSMERR_TP_NOT_TRUSTED`); codesign and TCC don't care.

**How to apply:**
- `updater.ts` `extractAndSign` keeps a release signature that passes `codesign --verify --deep
  --strict` and ad-hoc re-signs only on failure. Never make it re-sign unconditionally — that
  turns the stable DR back into a cdhash and resets grants on every update.
- Losing or rotating the cert resets everyone's grants once. Keep the `.p12` backed up.
- Not Developer ID, not notarized: Gatekeeper still asks on first open of a downloaded DMG
  (in-app updates aren't quarantined). Developer ID later = put its identity in
  `BEAN_SIGN_IDENTITY` and add hardened runtime + notarization.
- Verify a packaging change with a real `pnpm dist:mac`: `codesign -d -r- Bean.app`, and the
  zip extracted with `ditto -x -k` must still pass `codesign --verify --deep --strict`.
