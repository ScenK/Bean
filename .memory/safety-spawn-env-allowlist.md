# Spawned CLIs get an allowlisted env; fetch tools refuse private addresses

**Env.** Every untrusted-instruction spawn site (delegates, live sessions, routine command steps,
watch commands) builds its child env with core's `spawnEnv(extra)`, never `{ ...process.env }`.
Delegates run with permissions skipped, so a full env let them read Bean's `OPENAI_API_KEY` or a
bot token. The allowlist (`spawn-env.ts`) is shell basics + proxy/CA/`SSH_AUTH_SOCK` + the auth and
config-dir vars claude/codex/opencode need. A CLI that breaks because a var is missing → add that
one name, not a spread. Trusted children (Bean's own chatops servers, devtunnel) keep the full env.
`spawn-env.test.ts` fails if `...process.env` reappears anywhere else in `packages/*/src`.

**Fetch.** URL fetches steered by untrusted text (`fetch_url`, watch feeds, routine-builder feed
discovery) go through `safeFetch()`: http(s) only, IP literals checked up front, hostnames checked
inside the socket's own `lookup` (so the connection is pinned to the checked address — no
rebinding window), every redirect hop re-checked, one deadline + byte cap. It does not send
`Accept-Encoding`, so bodies arrive uncompressed. Don't swap it back to global `fetch`.
