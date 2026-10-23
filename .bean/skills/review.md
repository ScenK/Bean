---
description: Review a branch or pull request and end with a PASS/FAIL verdict — gates a sprout
---

# Review

Review the change you are given (the current branch vs its base, or the named pull request via
`gh pr diff`). Read-only: don't edit files, comment, approve, or push.

Severity rubric:

- **P0** — breaks the build, loses data, or opens a security hole.
- **P1** — wrong behavior on a realistic input, or the ticket's acceptance criteria aren't met.
- **P2** — clarity, naming, small simplifications. Never a reason to fail.

Output: one line per finding, `[P0|P1|P2] file:line — problem — suggested fix`, most severe
first. FAIL when any P0 or P1 is open; PASS otherwise.
