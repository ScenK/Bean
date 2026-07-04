# CLAUDE.md

@../AGENTS.md

## Claude Code — Specific Guidance

Tips that only apply to Claude Code sessions. Everything else lives in `AGENTS.md`.

### Memory

- **Team memory** is `.memory/` (cross-tool, committed) — read `.memory/INDEX.md` at session
  start and add entries per the [Memory protocol](../AGENTS.md#memory-protocol). This is the
  shared layer; treat it as authoritative over your personal store.
- **Personal memory** (Claude's `~/.claude/projects/<project>/memory/`) is for your own
  preferences and workflow style only. **Never** promote it into `.memory/` — that's the
  team's space.
- After `/compact`, this file and `AGENTS.md` are re-read.

### Workflow Preferences

- Use **plan mode** for changes spanning both packages or touching the preload/IPC boundary.
- Use **act mode** for single-file fixes, test additions, and docs.
- Run `pnpm test && pnpm typecheck` via the terminal before reporting success.
