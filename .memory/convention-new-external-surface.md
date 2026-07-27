# Checklist: adding a new external surface

Run this at **design time** whenever a change adds a place where outside data enters or
leaves Bean — an HTTP route, a chat attachment ingest, a webhook, a spawned fetch, a new
file the app serves or writes from untrusted input. These are the finding classes AI
reviewers reliably raise afterward (PR #94 collected six of them post-hoc); catching them
up front keeps review rounds short.

- **Authorization** — who may hit this? "Nobody needs to" often means the surface shouldn't
  exist; prefer deleting it over armoring it (see AGENTS.md → Review policy).
- **Rate limiting** — any unauthenticated handler that touches disk/network needs it
  (CodeQL flags this mechanically).
- **Size caps, enforced early** — check `Content-Length`/declared size *before* buffering a
  body; cap aggregate size/count per message, not just per item.
- **Input allowlist, not denylist** — exact MIME/format allowlist matched to what the
  downstream API actually accepts (e.g. OpenAI vision: png/jpeg/webp — `image/*` lets
  HEIC/SVG/animated GIF through and fails the turn later).
- **Failed-response handling** — check `res.ok` before consuming a body; an error page
  encoded as payload poisons the downstream call.
- **Unhandled rejections** — every fire-and-forget promise (`void p`) in a bot/server gets
  `.catch(...)`; one rejection kills the process.
- **Name/path generation** — anything written to a shared directory needs a
  collision-resistant name (UUID component), and anything served back must never be
  addressable by guessable name.
- **Gating order** — do the expensive/authenticated work *after* the "is this message even
  for us" gate, not before.
