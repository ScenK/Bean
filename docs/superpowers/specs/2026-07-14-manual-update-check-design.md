# Manual "Check for Updates" — Design

Date: 2026-07-14

## Overview

Bean gets a manual update flow, driven entirely from the About panel:

1. User clicks **Check for Updates**.
2. Bean checks GitHub Releases for a newer version, and if one exists, downloads
   and cryptographically verifies it automatically.
3. If verification passes, the About panel shows the new version + release notes
   and an **Install & Relaunch** button.
4. User confirms → Bean swaps its own `.app` bundle in place and restarts into
   the new version.

No background polling, no silent installs, no auto-download without an explicit
click. Every state change is visible and user-initiated.

## Non-goals

- No in-app progress percentage for the download (spinner only for v1).
- No Windows/Linux update path (Bean's mac-only distribution today).
- No fallback to a signed/notarized Developer ID flow — this explicitly targets
  the ad-hoc-signed distribution model Bean already ships.
- No admin-privilege elevation if `/Applications` isn't writable — that case
  surfaces an error with a link to the GitHub release page instead.

## Why not Sparkle.framework or electron-updater

- **electron-updater / Electron's built-in `autoUpdater`** wrap Squirrel.Mac,
  which is designed around continuous background polling and doesn't have a
  clean "manual check, then explicit confirm-to-install" mode without fighting
  its state machine. It also has no cryptographic authenticity check of its
  own beyond incidental code-signing consistency — weaker than what we're
  building here.
- **Real Sparkle.framework** (as used by reference project `agent-island`,
  github.com/tristan666666/agent-island) proves ad-hoc signing is *not* a
  blocker for auto-update — Sparkle's authenticity check is an EdDSA signature
  over each release (`SUPublicEDKey` + `sign_update`), independent of Apple
  code-signing tier. But Sparkle is a native Cocoa framework linked directly
  into a native app's binary; Bean's main executable is Electron's own
  prebuilt binary, and there's no supported way to link Sparkle into that
  (see electron/electron#5850, #29057 — both open, unresolved, official
  guidance stays with Squirrel.Mac).
- **What we take from Sparkle instead:** the EdDSA authenticity model, without
  the framework. Node's built-in `crypto` module signs/verifies Ed25519
  natively — no vendored framework, no native addon, no XPC helpers. This
  gives the same cryptographic guarantee (only the holder of the private key
  can produce an update Bean will accept) with a fully hand-rolled,
  Node/Electron-native implementation.

## Security model

- A single Ed25519 keypair is generated once, out of band.
- **Public key**: committed in source as a constant
  (`packages/core/src/update-public-key.ts`, PEM-encoded). Public keys are not
  secret — they ship inside the app so it can verify signatures.
- **Private key**: stored only as a GitHub Actions secret
  (`UPDATE_ED_PRIVATE_KEY`, PEM-encoded), never committed. Optionally kept in
  the maintainer's Keychain for local dry-run signing.
- **Release signing**: after `pnpm dist:mac` produces the `.zip`, a small
  script (`packages/app/scripts/sign-release.mjs`) signs the zip's raw bytes
  with the private key and writes a sidecar `<name>.zip.sig` (base64 signature
  text) uploaded as its own GitHub Release asset, alongside the existing
  `.dmg`/`.zip`.
- **Update verification**: Bean downloads both the `.zip` and its `.sig`
  asset, then calls `crypto.verify(null, zipBuffer, publicKeyObject,
  signatureBuffer)`. Only on a valid signature does it proceed to extract and
  install. A failed/missing signature is a hard stop — Bean never installs an
  unsigned or mismatched-signature update.
- **Key rotation caveat** (same as Sparkle's own docs): losing the private key
  means existing installs can no longer verify future updates against it.
  Recovery requires shipping a new build with a new public key baked in, which
  existing installs can't self-migrate to — this is accepted as a rare,
  manual-recovery scenario, not designed around further.
- Ad-hoc re-signing (`codesign --force --deep --sign -`) still happens on the
  extracted bundle before install, purely to satisfy macOS's "must be signed to
  execute" requirement (AMFI) — same command as `packages/app/scripts/after-sign.mjs`
  already uses at build time. This is unrelated to the EdDSA authenticity check
  above and confers no additional trust — it is not notarization.

## Architecture

### `packages/core/src/updater.ts` (pure, dependency-injected)

- `compareVersions(a: string, b: string): number` — plain `X.Y.Z` comparison
  (strips a leading `v`), no `semver` dependency.
- `checkForUpdate(deps: { currentVersion: string; release: GithubReleaseInfo }): UpdateCheckResult`
  — picks the `-arm64-mac.zip` asset and its `.sig` sidecar from the release's
  asset list, compares versions, and returns:
  - `{ status: "up-to-date" }`
  - `{ status: "available", version, notes, zipAsset, sigAsset }`
  - `{ status: "error", message }` (malformed release payload, e.g. missing
    the expected assets)

### `packages/core/src/update-public-key.ts`

- Exports the committed Ed25519 public key (PEM) as a constant.

### `packages/app/src/updater.ts` (new — Electron/Node IO)

- `fetchLatestRelease(): Promise<GithubReleaseInfo>` — `GET
  https://api.github.com/repos/ScenK/Bean/releases/latest` (unauthenticated;
  60 req/hr/IP is ample for a manual button), mapped to core's shape.
- `downloadAsset(url): Promise<Buffer>` — streams a release asset into memory
  (zip is ~125MB; acceptable for a one-shot manual download, no separate
  disk-streaming optimization needed for v1).
- `verifySignature(zipBuffer, sigBase64): boolean` — wraps `crypto.verify`
  against the committed public key.
- `extractAndSign(zipBuffer): Promise<{ appPath: string }>` — writes the zip
  to a temp file, `ditto -x -k` extracts it into a fresh temp dir, then runs
  the same `codesign --force --deep --sign -` invocation as
  `after-sign.mjs`.
- `installAndRelaunch(extractedAppPath): Promise<never>` — resolves the
  currently-running bundle path from `app.getPath("exe")` (walk up three
  segments from `.../Bean.app/Contents/MacOS/Bean` to `Bean.app`), then:
  1. `rename(currentAppPath, currentAppPath + ".old")`
  2. `rename(extractedAppPath, currentAppPath)` — on `EXDEV` (cross-device),
     fall back to recursive copy + remove.
  3. If step 2 fails, `rename` `.old` back to restore, surface an error, abort.
  4. On success, best-effort `rm -rf` the `.old` directory (safe even though
     Bean's own process is still executing from those now-detached inodes —
     standard Unix unlink-while-open semantics).
  5. `app.relaunch(); app.exit()`.
- Every function here is gated on `app.isPackaged` — dev builds
  (`electron dist/main.js` directly, no stable `.app` path) show "Updates
  aren't available in a dev build" instead of attempting anything.

### IPC (`channels.ts` + `ipc.ts` + `main.ts`, following the existing
`getAppInfo`-style handler pattern)

- `IPC.checkForUpdate = "bean:check-for-update"` (invoke) — runs the full
  check → download → verify → extract → sign pipeline in one call (a single
  user click covers "check" and "download" per the approved flow) and
  returns one of:
  - `{ status: "up-to-date" }`
  - `{ status: "available", version, notes }` — the extracted, ad-hoc-signed
    bundle's path is held server-side in a small in-memory store (same
    pattern as `planStore`/`droppedUrlStore`), keyed since IPC is
    stateless request/response and the next call needs to reference it.
  - `{ status: "error", message }` — network failure, malformed release,
    signature verification failure, or extraction/codesign failure all land
    here with a message distinguishing which step failed.
- `IPC.installUpdate = "bean:install-update"` (invoke) — runs
  `installAndRelaunch` against the stored extracted bundle path; the renderer
  never gets a normal response since the process exits.

### UI (`packages/app/src/renderer/components/about/AboutWindow.tsx`)

Add below the existing version line:

- **idle**: "Check for Updates" button.
- **checking**: button disabled, "Checking for updates…" (covers check +
  download + verify, since they're one IPC round-trip).
- **up-to-date**: transient "You're up to date" message, button re-enabled.
- **available**: shows new version + release notes snippet, "Install &
  Relaunch" button.
- **installing**: button disabled, "Installing…" (app exits shortly after).
- **error**: error message (network / signature / extraction, phrased
  per-cause) plus a "View release on GitHub" link (`shell.openExternal`) as a
  manual fallback.
- Gated entirely off when `!info?.isPackaged` (add `isPackaged` to the
  existing `AppInfo` shape returned by `getAppInfo`) — shows a static "Updates
  aren't available in a dev build" note instead of the button.

## Release pipeline changes (`.github/workflows/mac-installer.yml`)

After the existing `pnpm dist:mac` step:

1. Run `node packages/app/scripts/sign-release.mjs packages/app/release/*.zip`
   with `UPDATE_ED_PRIVATE_KEY` from GitHub Secrets, producing `<zip>.sig`
   next to the zip.
2. Include the `.sig` file in both the `upload-artifact` step and the
   `gh release create` asset list, alongside the existing `.dmg`/`.zip`.

Only the `.zip` is signed/used by the updater — the `.dmg` stays as a
plain manual-download convenience, unchanged.

## One-time maintainer setup (documented in a new `.memory/` entry, not
duplicated in code comments)

1. Generate the keypair locally: `node -e
   "console.log(require('crypto').generateKeyPairSync('ed25519', {
   publicKeyEncoding:{type:'spki',format:'pem'},
   privateKeyEncoding:{type:'pkcs8',format:'pem'} }))"` (or a small
   `scripts/generate-update-keys.mjs` wrapping the same call for
   repeatability).
2. Paste the public key PEM into `packages/core/src/update-public-key.ts`.
3. Add the private key PEM as the `UPDATE_ED_PRIVATE_KEY` GitHub Actions
   secret. Do not commit it anywhere.

## Error handling / edge cases

- Network failure fetching the release or downloading assets → error state,
  retry via clicking the button again.
- Missing `.sig` asset on the latest release (e.g. accidentally published
  without running the sign step) → `checkForUpdate` only ever considers
  `releases/latest`, so this surfaces as an `error` ("release is missing its
  signature") rather than silently treating it as up-to-date or installing
  unverified.
- Signature verification failure → hard error, never extract/install,
  explicit "signature verification failed" message distinct from network
  errors.
- `/Applications` not writable (or wherever Bean is installed) → catch the
  rename/EACCES failure during `installAndRelaunch`, roll back if partially
  applied, surface an error pointing at the GitHub releases page.
- Dev builds (`!app.isPackaged`) → feature hidden entirely, not just
  disabled-with-error.

## Testing

- **Core**: unit tests for `compareVersions` and `checkForUpdate` against
  fixture release payloads (up-to-date / available / missing assets /
  malformed).
- **App**: unit tests for `updater.ts` with injected fake fetch/fs/crypto
  results (no real network or filesystem), matching the DI style already used
  elsewhere in `app/`. Cover: signature pass/fail, EXDEV fallback path,
  rollback-on-failed-swap.
- **Manual** (required before calling this done, per `AGENTS.md`'s packaged-
  build verification bar): a real `pnpm dist:mac`, sign it with a test
  keypair, publish as a throwaway pre-release, and exercise check → download
  → verify → install → relaunch against a real installed Bean.app.
