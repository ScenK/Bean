# Parsing a model's JSON: test with real replies, never only the "ideal" shape

**What broke (#1166):** the proactive pulse (`core/src/pulse.ts`) shipped and never planted a
single Seed. The reply template listed `"id"` first ("existing seed id, to reword it"), and the
real model often made up an id for a brand-new seed. The parser skipped any id that matched no
active seed, so every new seed was dropped without a trace. Unit tests passed because their fake
`chat` returned the ideal shape (new seeds with no `id`).

**Rule:** when code parses free-form model output (JSON plans, picks, ids):

- Be lenient about fields the model can't know. An id/key the model was never shown means "new"
  (or gets ignored), not "drop the item". Only reject a reference to something it *was* shown
  and is no longer valid (e.g. a closed seed's id).
- In the template, mark optional fields as optional ("omit for a new seed"). Don't let a
  placeholder read like a required field.
- Test the messy shapes too: an invented id, an extra field, a missing optional field.
- Before shipping, run the code once against the **real model** on a copy of real data
  (`sqlite3 ~/.bean/bean.db ".backup /tmp/x.db"`, call the exported core function with
  `makeOpenAIConverse`), and look at the raw reply and the outcome, not just whether it ran.
