---
name: project-manual-update-check
description: Manual "Check for Updates" flow — Ed25519-signed GitHub Releases, no Sparkle/electron-updater, ad-hoc re-sign on install.
metadata:
  type: project
---

Bean's update flow is fully manual: the About panel's "Check for Updates" button drives
`packages/core/src/updater.ts` (`compareVersions`/`checkForUpdate`/`verifyUpdateSignature` —
pure) and `packages/app/src/updater.ts` (fetch/download/extract/install — IO), wired through
`bean:check-for-update`/`bean:install-update` IPC. No background polling; every step is a
user click.

**Why not Sparkle/electron-updater:** see
`docs/superpowers/specs/2026-07-14-manual-update-check-design.md`. Short version: ad-hoc
signing (matching [safety-mac-adhoc-signing.md](safety-mac-adhoc-signing.md)) is NOT the
blocker it looks like — Sparkle's authenticity check is EdDSA, independent of code-signing
tier — but Sparkle.framework itself has no supported Electron embedding (electron/electron
#5850, #29057, both unresolved). We took the EdDSA idea without the framework: Node's
built-in `crypto` module signs/verifies Ed25519 natively.

**Security model:** a committed Ed25519 public key
(`packages/core/src/update-public-key.ts`) verifies a `.sig` sidecar asset the release
workflow produces via `packages/app/scripts/sign-release.mjs` (private key only in the
`UPDATE_ED_PRIVATE_KEY` GitHub Actions secret, never committed). A failed/missing signature
is a hard stop — Bean never extracts/installs an unverified update. Ad-hoc re-signing the
extracted bundle (`codesign --force --deep --sign -`, same command as `after-sign.mjs`)
still happens before install, but that's only the AMFI "must be signed to execute" bar — it
doesn't substitute for the EdDSA check.

**Install mechanism:** `installAndRelaunch` (`packages/app/src/updater.ts`) does the same
rename-dance Sparkle/Squirrel use — current `Bean.app` → `.old`, extracted bundle → the live
path (EXDEV falls back to a recursive copy), roll back on failure — then `app.relaunch();
app.exit()`. Before the backup rename it clears any pre-existing `.old` by renaming it aside
to a `.stale-<uuid>` path (best-effort `rm` after, discarded either way) rather than deleting
it in place: a leftover from a previous install (cleanup failed, or the process died mid-swap)
makes `rename(Bean.app → Bean.app.old)` throw `ENOTEMPTY: directory not empty` on macOS, and a
recursive `rm` of that leftover can itself silently fail on a permission-restricted file deep
inside — needs write access to every descendant, unlike a rename which only needs it on the
directory entry — leaving the destination still occupied and the exact same ENOTEMPTY error a
first fix (#55) tried to prevent (its `rm(backupPath).catch(() => {})` swallowed that error
too, so the pre-clear silently no-opped on a real install). Gated on
`app.isPackaged`, but the gate itself lives one layer up — in `buildUpdateHandlers`
(`packages/app/src/ipc.ts`), not inside `updater.ts`'s functions. `check()`/`install()`
short-circuit with a dev-build error before ever calling `checkAndDownloadUpdate`/
`installAndRelaunch` or touching the pending-update store, so dev builds can't trigger real
IO through any caller of the IPC surface (not just the visible About-panel button).

**Key rotation:** losing the private key strands existing installs — they can't verify
future updates against a new key. Recovery is a new build with a new public key that
existing installs can't self-migrate to; accepted as a rare manual-recovery case.
