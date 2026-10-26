# project-routine-continues

> Sprouts in copy; routines in code — see [convention-sprouts-copy-routines-code.md](convention-sprouts-copy-routines-code.md).

A delegate step's `continues: "<earlier step id>"` resumes that step's agent session instead of
starting a fresh one (#433, epic #432). Sessions are keyed by **lane**: `stepLanes()` maps each
step to the root of its `continues` chain (A→B→C is one lane), and the runner's `sessions` map is
read and written by lane root — so a step resumes the lane's **newest** session (C continuing A
after B continued A gets B's id; a looping step still resumes its own previous round). Lanes are
per `runSteps` call, so two todos never share one. An empty lane (target skipped by a route, or
failed) runs fresh and its output is prefixed `(No earlier session from <id> to continue — started
fresh.)`. `continues` alone does **not** turn on graph mode (`usesGates` ignores it).

**Same-cli / same-project rule.** Target must be an earlier **delegate** step, and both steps must
pin the **same `cli`** (an unpinned step could be inferred onto another harness, and the adapter
silently drops a cross-CLI resume) and have the **same `project`** (both omitted counts as same) —
a session resumed in another cwd points at files that aren't there. In a parallel group a member
can't continue a sibling, and no two members may share a lane (they'd resume one session at once).
All rules live in `describeContinueErrors`/`continueProblem` (`routine-graph.ts`) — one wording for
the save check, `stepEdgeProblems`, and the editor's `continueTargets` picker. `parseBrief` drops a
rejected `continues`, never the step.

Host: any `continues` holds the per-todo scratch for the whole run (like gates). Receipts are
collected per session id and formatted by `formatReceipts`: one footer line per session
(`steps 2→4→6 (kubernetes) — opencode -s <id>`), a gate loop's repeated id included.
