# safety: plan (read-only) delegates are locked down by argv, not by prompt

`DelegateRequest.mode: "plan"` (#908) must stay enforced by the CLI, never by instruction text.
`delegateCommand()` builds a separate argv with no bypass flag; ordinary mode is unchanged.

- **claude:** `--permission-mode plan --settings '{"disableAllHooks":true}' --tools
  Read,Glob,Grep --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome` (`browser`
  is ignored). Plan mode alone still exposes Write, Task, RemoteTrigger, Cron*, user/plugin MCP
  — the `--tools` allowlist is the lock; the model's own "plan mode forbids it" refusal is not
  evidence. Hooks (user, project `.claude/settings.json`, plugins) run shell commands outside
  the tool allowlist before any model turn — `disableAllHooks` is what stops them. Resume keeps
  every flag.
- **codex:** `--sandbox read-only --ignore-user-config --ignore-rules -c web_search="disabled"` plus
  `--disable plugins/apps/browser_use/computer_use/in_app_browser`. A `-c mcp_servers={}`
  override **merges** — user MCP servers (e.g. `node_repl`, which runs outside the sandbox) stay
  callable; only `--ignore-user-config` drops them (and leaves the project untrusted, so its
  `.codex/config.toml` servers don't load). `--ignore-user-config` still loads `~/.codex/rules/`:
  a saved `prefix_rule(..., decision="allow")` runs the command outside the sandbox (a `curl`
  rule got HTTP 200) — `--ignore-rules` is required. `exec resume` rejects `--sandbox`, so plan runs are
  fresh only and `runDelegate` drops `resume` up front (no fresh-retry notice).
- **opencode, agy:** refused in `runDelegate()` before spawn (`planRefusal(cli)`);
  `delegateCommand()` throws rather than fall back. Any new CLI is refused until probed.

Re-probe after a CLI upgrade before trusting it: ask the run to write a file, fetch a URL, call
an MCP tool and write under `.git`; plant a project hook that touches a file (claude) and a saved
allow rule for `curl` in a temp `CODEX_HOME` (codex); then check the filesystem and the init/tool events — not the
model's report. Verified 2026-11 on claude 2.1.325 and codex-cli 0.169.0.
