// Spawned CLIs (delegates run with permissions skipped, command steps, watch commands) inherit
// only these variables from Bean's env — never the whole thing, so a parent `OPENAI_API_KEY` or
// bot token can't be read by a prompt-steered child. Add a name here only when a supported CLI
// (claude/codex/opencode) or the shell basics demonstrably need it.
const ALLOWED = new Set([
  // Shell basics
  "HOME", "PATH", "PWD", "TZ", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  // Network / git plumbing the CLIs and their git calls rely on
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSH_AUTH_SOCK",
  // Bean's git identity (BEAN_GIT_IDENTITY)
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  // Claude Code
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  // Codex
  "CODEX_HOME",
  // OpenCode
  "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR",
]);

/** The child env for every spawned CLI/shell: the allowlisted subset of `source`, then `extra`
 * on top (caller-chosen values — resolved PATH, PWD, git identity, a routine's own `env`). */
export function spawnEnv(extra: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && ALLOWED.has(k)) env[k] = v;
  return { ...env, ...extra };
}
