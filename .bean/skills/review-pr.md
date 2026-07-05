---
name: 'review-pr'
target: terminal
description: 'Review GitHub PRs for merge safety in any repository. Categorizes affected components, analyzes dependency changes, reviews code quality, assesses risk, provides reproduction steps for issues found, posts review comments, and labels PRs. Usage: /review-pr [PR# PR# ...] or /review-pr (all open PRs)'
argument-hint: '[PR numbers, space-separated, or blank for all open PRs]'
---

# PR Review Skill

You are reviewing pull requests on the current GitHub repository. Your goal is to determine how safe each PR is to merge — especially dependency updates — and leave structured review feedback.

## Step 0: Detect Project Context

Before reviewing, understand the repository:

1. Identify the repo: `gh repo view --json name,owner,defaultBranchRef`
2. Detect the tech stack by checking for manifest files at the repo root (and notable subdirectories):
   - `package.json` / `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` → Node.js/JavaScript
   - `requirements.txt` / `pyproject.toml` / `poetry.lock` → Python
   - `go.mod` / `go.sum` → Go
   - `Cargo.toml` / `Cargo.lock` → Rust
   - `pom.xml` / `build.gradle` → Java
   - `Gemfile` / `Gemfile.lock` → Ruby
   - `composer.json` → PHP
3. Read the relevant manifest file(s) to learn which packages are runtime dependencies vs dev/test-only dependencies.
4. Skim the top-level directory structure (`ls` or the repo file tree) to understand the project layout for component categorization in Step 4.

Cache this context — read it once and reuse it across all PRs in this run.

## Step 1: Ensure the "AI Reviewed" Label Exists

Run once at the start:

```
gh label create "AI Reviewed" --color 8250DF --force 2>/dev/null || true
```

## Step 2: Determine Which PRs to Review

Parse `$ARGUMENTS` for PR numbers (space or comma separated).

- If arguments are provided, review those specific PRs.
- If no arguments are provided, fetch all open PRs:
  ```
  gh pr list --state open --json number,title,labels
  ```
  Then **skip PRs that already have the "AI Reviewed" label**. Filter them out by checking if any label in the `labels` array has `"name": "AI Reviewed"`.

  - If all open PRs already have the label, tell the user: "All open PRs have already been reviewed. To re-review a specific PR, run `/review-pr <PR#>` explicitly."
  - If some are skipped, list the skipped PRs and their titles so the user knows, then proceed with the remaining unreviewed PRs.

  **Note:** When specific PR numbers are provided via arguments, always review them regardless of label — this allows intentional re-reviews.

## Step 3: For Each PR — Gather Information

### 3a. Fetch PR metadata

```
gh pr view <N> --json number,title,body,files,labels,author,baseRefName,headRefName,additions,deletions,changedFiles,statusCheckRollup
```

### 3b. Fetch the full diff

```
gh pr diff <N>
```

### 3c. Use the project's dependency manifest for classification
Use the manifest(s) read in Step 0 to know which packages are runtime dependencies vs dev-only dependencies.

## Step 4: Categorize Affected Components

Map each changed file path to one or more component categories. Derive the categories from the actual project structure discovered in Step 0. Use these general heuristics:

| File Path Pattern (typical) | Component |
|---|---|
| Frontend/client source directories (`src/components/**`, `client/**`, `frontend/**`, `ui/**`) | Frontend |
| Backend/server source directories (`server/**`, `api/**`, `backend/**`, `app/**`) | Backend |
| Shared/common code (`common/**`, `shared/**`, `lib/**`) | Shared |
| Database code, migrations, models (`db/**`, `migrations/**`, `models/**`) | Database |
| Test directories (`tests/**`, `test/**`, `__tests__/**`, `spec/**`, `e2e/**`) | Testing |
| Dependency manifests and lockfiles (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, lockfiles, etc.) | Dependencies |
| Build configuration (`vite.config.*`, `webpack.config.*`, `tsconfig.json`, `Makefile`, `setup.py`, etc.) | Build Config |
| `Dockerfile`, `docker-compose.yml`, `docker/**`, `k8s/**`, `helm/**` | DevOps — Containers/Infra |
| `.github/workflows/**`, `.gitlab-ci.yml`, `.circleci/**` | DevOps — CI/CD |
| `scripts/**`, `tools/**` | Scripts/Tooling |
| `*.md`, `docs/**` | Documentation |
| Dotfiles and env/config files (`.env*`, `*.rc`, `config/**`) | Configuration |

Refine subcategories (e.g., "Frontend — State Management", "Backend — API") when the project's directory structure makes them evident.

If only dependency manifests and lockfiles are changed, the primary component is **Dependencies**.

## Step 5: Dependency Analysis (when dependency manifests or lockfiles changed)

From the diff, extract:
1. **Package name** — what's being bumped
2. **Version change** — old → new (identify major/minor/patch)
3. **Dependency type** — runtime or dev/test-only, based on the actual manifest
4. **Is it a critical runtime dependency?** Flag packages as critical when they fall into these categories:
   - Web framework / HTTP server (e.g., express, fastify, django, flask, rails, gin)
   - Database drivers and ORMs (e.g., mongodb, pg, mysql2, prisma, sqlalchemy, mongoose)
   - Authentication/session/crypto (e.g., jsonwebtoken, bcrypt, passport, session stores, cookie handling)
   - Core UI framework and routing (e.g., react, react-dom, vue, angular, routers)
   - State management (e.g., redux, zustand, pinia)
   - HTTP clients used in production paths (e.g., axios, requests)
   - Error monitoring / observability agents (e.g., sentry SDKs)
   - Email, payment, or other external-service SDKs in production paths
5. **Breaking changes** — scan the PR body/description for mentions of "breaking", "BREAKING CHANGE", "migration", "deprecated"

### Bump Level Classification
- **Patch** (e.g., 1.2.3 → 1.2.4): Bug fixes, low risk
- **Minor** (e.g., 1.2.3 → 1.3.0): New features, backward compatible, moderate risk
- **Major** (e.g., 1.2.3 → 2.0.0): Potentially breaking changes, high risk

Note: some ecosystems don't strictly follow semver (e.g., 0.x packages, Go pseudo-versions) — apply judgment and lean conservative.

## Step 6: Code Review (for non-dependency or mixed PRs)

When application source code is changed (not just dependency manifests), review the diff for:
- **Correctness** — logic errors, edge cases, null/undefined handling, off-by-one errors
- **Security** — injection risks, auth bypasses, exposed secrets, unsafe deserialization, OWASP top 10
- **Performance** — N+1 queries, missing indexes, memory leaks, large payloads, unnecessary re-renders/loops
- **Architecture** — adherence to the project's existing conventions (import patterns, module boundaries, layering) as observed in the codebase
- **Data layer** — query correctness, missing indexes, transaction/connection handling
- **Error handling** — proper error propagation, logging/monitoring integration
- **Breaking changes** — API contract changes, removed exports, changed function signatures

## Step 7: Assign Risk Verdict

Based on the analysis, assign ONE of these verdicts:

| Verdict | When to Use |
|---|---|
| **SAFE TO MERGE** | Patch bumps on dev-only dependencies; documentation-only changes; no breaking changes |
| **LIKELY SAFE — RECOMMEND TESTING** | Minor bumps on non-critical runtime deps; patch bumps on critical runtime deps; low-risk code changes |
| **NEEDS TESTING BEFORE MERGE** | Major bumps on any dependency; changes to critical runtime deps (minor+); breaking changes mentioned; significant code changes |
| **HOLD — NEEDS MANUAL REVIEW** | Multiple major bumps on critical runtime deps; security concerns found; architectural changes; changes to auth, payment, or data integrity code |

## Step 8: Steps to Reproduce (when issues are found)

For **every issue found in Step 6** (correctness, security, performance, etc.), construct the clearest possible reproduction steps so a human can verify the problem before deciding on the merge. For each issue provide:

1. **Issue summary** — one sentence describing the defect and its impact
2. **Location** — file path and line range from the diff (e.g., `src/api/orders.js:42-58`)
3. **Preconditions** — required environment, data state, config, or user role (e.g., "logged in as a non-admin user", "database contains an order with no line items")
4. **Reproduction steps** — a numbered, minimal sequence of concrete actions: exact commands to run, API requests (method, path, sample payload), or UI interactions
5. **Expected result** — what correct behavior would look like
6. **Actual/likely result** — what the buggy code will do instead (crash, wrong value, data leak, slow response, etc.)
7. **Suggested verification** — the fastest way to confirm the fix (e.g., a specific unit test to add, a curl command to re-run)

Guidelines:
- Prefer the **minimal** reproduction — the fewest steps and smallest input that trigger the issue.
- Use concrete values (sample payloads, IDs, inputs), not vague descriptions.
- For security issues, describe the reproduction responsibly: enough for the maintainer to verify, phrased as a test case rather than an exploit guide.
- For performance issues, specify the data scale needed to observe the problem (e.g., "with 10k+ rows in the table").
- If an issue is speculative and cannot be reliably reproduced from the diff alone, say so explicitly and state what additional information would confirm it.

## Step 9: Post the Review Comment

Compose a structured review comment. Write it to a temp file first to avoid shell escaping issues:

Write the review to `/tmp/pr-review-<N>.md` with this structure:

```markdown
## PR Review: #<N> — <PR Title>

### Components Affected
<List each affected component as a bullet, e.g.:>
- Dependencies
- Frontend — Features
- Backend — API

### Risk Assessment
**Verdict: <VERDICT>**

<Brief explanation of why this verdict was chosen — 2-3 sentences max.>

### Dependency Analysis
<Only include this section if dependency manifests/lockfiles were changed>

| Package | Change | Type | Bump | Risk |
|---------|--------|------|------|------|
| <name> | <old> → <new> | Runtime/Dev | Major/Minor/Patch | Low/Medium/High |

<Summary of dependency risk findings>

### Code Review Findings
<Only include this section if application source code was changed>

<List any findings as bullets. If no issues found, state "No issues found in code changes.">

### Steps to Reproduce
<Only include this section if issues were found in Code Review Findings>

<For each issue, include:>

#### Issue 1: <short title>
- **Location:** <file:lines>
- **Preconditions:** <environment/data/role requirements>
- **Steps:**
  1. <step>
  2. <step>
- **Expected:** <correct behavior>
- **Actual:** <buggy behavior>
- **Verify fix by:** <test or command>

### Recommendation
<Clear, actionable recommendation: merge as-is, merge after testing X, or hold for manual review. Be specific about what to test if testing is recommended.>

---
Code reviewed by Claude (`<model-name>`) | AI-assisted review — human approval required before merge
```

Replace `<model-name>` with the actual model you are running as (e.g., `claude-opus-4-6`, `claude-sonnet-4-5-20250929`, etc.).

Then post the comment:

```
gh pr review <N> --comment -F /tmp/pr-review-<N>.md
```

## Step 10: Add the Label

```
gh pr edit <N> --add-label "AI Reviewed"
```

## Step 11: Print Summary

After all PRs are reviewed, print a summary table to the user:

```
| PR# | Title | Components | Verdict | Issues Found |
|-----|-------|------------|---------|--------------|
| ... | ...   | ...        | ...     | ...          |
```

Tell the user which PRs were reviewed and provide any overall observations (e.g., "All 6 PRs are Dependabot dependency bumps — none modify application source code").

## Important Notes

- **Never auto-approve** — only leave comment reviews. The human makes the final merge decision.
- **Be conservative** — when in doubt, recommend testing over merging directly.
- **Check CI status** — if `statusCheckRollup` shows failed checks, always flag this and set verdict to at minimum "NEEDS TESTING".
- **Skip already-reviewed PRs** — when no PR numbers are given, skip PRs with the "AI Reviewed" label. When specific PR numbers are passed as arguments, always review them (intentional re-review). Note in the comment if this is a re-review.
- **Batch efficiently** — when reviewing multiple PRs, read the repo context and dependency manifest(s) once (Step 0) and reuse them.
- **Reproduction steps are mandatory for issues** — never report a code issue without either reproduction steps or an explicit note that it's speculative and what would confirm it.
