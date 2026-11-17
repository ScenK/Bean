# safety: plan (read-only) delegates are locked down by argv, not by prompt

`DelegateRequest.mode: "plan"` (#908) must stay enforced by the CLI, never by instruction text.
`delegateCommand()` builds a separate argv with no bypass flag; ordinary mode is unchanged.

- **claude:** `--permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --mcp-config
  '{"mcpServers":{}}' --no-chrome` (`browser` is ignored). Plan mode alone still exposes Write,
  Task, RemoteTrigger, Cron*, user/plugin MCP — the `--tools` allowlist is the lock; the
  model's own "plan mode forbids it" refusal is not evidence. Resume keeps every flag.
- **codex:** `--sandbox read-only --ignore-user-config -c web_search="disabled"` plus
  `--disable plugins/apps/browser_use/computer_use/in_app_browser`. A `-c mcp_servers={}`
  override **merges** — user MCP servers (e.g. `node_repl`, which runs outside the sandbox) stay
  callable; only `--ignore-user-config` drops them (and leaves the project untrusted, so its
  `.codex/config.toml` servers don't load). `exec resume` rejects `--sandbox`, so plan runs are
  fresh only and `runDelegate` drops `resume` up front (no fresh-retry notice).
- **opencode:** refused in `runDelegate()` before spawn (`OPENCODE_PLAN_REFUSAL`);
  `delegateCommand()` throws rather than fall back.

Re-probe after a CLI upgrade before trusting it: ask the run to write a file, fetch a URL, call
an MCP tool and write under `.git`, then check the filesystem and the init/tool events — not the
model's report. Verified 2026-11 on claude 2.1.325 and codex-cli 0.169.0.
