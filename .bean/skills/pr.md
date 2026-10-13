---
description: Push the current branch and open a pull request that explains itself
---

# Open a pull request

Push the current branch and open a pull request with `gh pr create` against the default branch.
If one is already open for this branch, update its description instead of opening another.

The body has these sections: **Why** (the ticket, linked), **What changed**, **Deliberately
skipped**, **Verification** (tests run, review outcome). Close the ticket with `Closes #<n>`
when it is a GitHub issue.

Output: the pull request URL on its own line.
