# safety — Mac installer's release-attach step must stay retrying + idempotent

The `mac-installer.yml` workflow builds/signs/uploads the DMG+ZIP on every `v*` tag, then a
final **"Attach to release"** step runs `gh release create` to publish a GitHub Release. That
last step talks to GitHub's REST API, which intermittently returns transient 5xx errors.

**v0.20.0 and v0.20.1 both failed here** (2026-07-20, within a ~4-minute window): every build
step was green — `pnpm test`, `typecheck`, `dist:mac`, sign, and `upload-artifact` all
succeeded — and only the release-attach step died on `HTTP 503` from
`api.github.com/.../releases/tags/<tag>`. The expensive build was wasted and no Release was
created, even though the artifacts existed as workflow artifacts.

Because of that, the step now:

- **retries with backoff** (5 attempts, 10s·attempt) so a transient API blip doesn't discard a
  fully-built release, and
- **stays idempotent**: it checks `gh release view` first and uses `gh release upload --clobber`
  if a prior attempt already created the release, otherwise `gh release create --generate-notes`.

Don't collapse this back to a single bare `gh release create` — a one-shot call re-introduces
the "one 503 nukes the whole release" failure. If a release still fails here after all retries,
suspect an actual GitHub API incident (check status), not the build.
