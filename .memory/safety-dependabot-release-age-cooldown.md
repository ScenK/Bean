# Dependabot PRs die on pnpm's release-age policy — keep the cooldown in step

pnpm 11 refuses lockfile entries published less than 24h ago
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, a supply-chain cooldown). Dependabot opens its PR
within minutes of a release, so the CI `test` job's "Sync lockfile for dependabot PRs" step
hits that policy and the job fails on a lockfile that is otherwise perfectly correct — PR #89
(`@playwright/test` 1.62.0, published ~17h before the run) is the case that surfaced it. CI
runs once per push, so nothing re-runs the job after the version ages out and the PR just
stays red until someone clicks re-run.

Three pieces keep this from recurring; they only work together:

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` explicitly. It is also pnpm 11's
  default, but as an invisible default it was un-greppable — the CI error named a setting that
  appeared nowhere in the repo.
- `.github/dependabot.yml` sets `cooldown.default-days: 2`, so dependabot holds a bump until
  it can pass that check. **Keep it >= `minimumReleaseAge`** — raising one without the other
  puts the birth-broken PRs right back.
- The CI sync step greps the pnpm output for the violation and emits a `::error::` explaining
  it. Deliberately still exits 1: the policy is doing its job, and bypassing it with
  `--config.minimumReleaseAge=0` would silently drop the protection on exactly the PRs
  (fresh third-party releases) it exists for. A re-run after the window is the fix.
