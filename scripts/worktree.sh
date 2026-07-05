#!/usr/bin/env bash
# Create/remove git worktrees under .worktrees/<branch>, wired to root pnpm scripts.
# Usage: pnpm worktree:create <branch> | pnpm worktree:remove <branch>
set -euo pipefail

cmd="${1:-}"
branch="${2:-}"
root="$(git rev-parse --show-toplevel)"
dir="$root/.worktrees/$branch"

case "$cmd" in
  create)
    [ -n "$branch" ] || { echo "usage: pnpm worktree:create <branch>" >&2; exit 1; }
    git worktree add "$dir" -b "$branch"
    (cd "$dir" && codegraph init)
    echo "Worktree ready at $dir"
    ;;
  remove)
    [ -n "$branch" ] || { echo "usage: pnpm worktree:remove <branch>" >&2; exit 1; }
    git worktree remove "$dir" --force
    git branch -D "$branch" 2>/dev/null || true
    ;;
  *)
    echo "usage: pnpm worktree:create|remove <branch>" >&2
    exit 1
    ;;
esac
