# converse() uses /v1/responses, not /v1/chat/completions

`makeOpenAIConverseWithClient` (`packages/core/src/openai-chat.ts`) calls
`client.responses.create`. Don't "simplify" it back to `chat.completions`.

**Why:** `converse()` always sends function tools, and OpenAI rejects function tools combined
with any `reasoning_effort` other than `none` on chat.completions for `gpt-5.4-nano` and newer:

> Function tools with reasoning_effort are not supported for gpt-5.6-luna in
> /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.

Older `gpt-5-nano` still accepts `low`/`high` there, so the restriction reads as a deliberate
migration, not a bug. `/v1/responses` accepts every effort with tools.

**Load-bearing details:**

- `store: false` is required, not a preference. Responses defaults to `store: true`, which
  would persist every Bean conversation in the user's OpenAI account; chat.completions never did.
- `reasoningEffort: ""` must send **no** `reasoning` key at all. Passing `reasoning.effort` to a
  model without reasoning is a hard 400 (`Unsupported parameter`), so `""` is the safe default
  for `gpt-4o-mini`/`gpt-5.4-nano`, not a stand-in for some effort value.
- Reasoning items in `output[]` are dropped. Verified against the live API: a follow-up call
  carrying only `function_call` + `function_call_output` is accepted and answers correctly, so
  converse()'s 3-round tool loop carries no encrypted reasoning state.
- `strict: false` must be sent on every tool. Responses treats an **omitted** `strict` as
  `true`, and a strict schema makes every property required — which silently forced
  `propose_run`'s optional `project` (killing the no-project scratch run) and
  `propose_delegate`'s optional `skill`/`cli`/`model`. Verified live: omitted `strict` echoes
  back as `true` and the model always fills the optional argument; `strict: false` restores it.
- A message part is `output_text` **or** `refusal`, and a refusal carries no `text` at all.
  Reading only `text` turns a refusal into an empty, silent reply.
- Only `completed` is usable. `failed`/`cancelled` throw (their partial output is not an
  answer); `incomplete` throws if it produced a tool call — an unfinished response must never
  trigger an action — and otherwise labels its partial text rather than passing it off as
  finished.
- Shape differences from chat.completions, all easy to get wrong: tools are flat (no nested
  `function:`), images are `input_image` with a bare `image_url` string, an assistant turn with
  N tool calls expands to N sibling `function_call` items, and the id to echo back is
  `call_id`, not the item's `id` (`fc_…`).
- `makeOpenAIChat` (the `route()` path, no longer called by any renderer code) deliberately
  stays on chat.completions. It sends no tools, so nothing forced it to move.

**The bug this port introduced and how it's guarded:** a dynamic tool enum that comes out empty
(`enum: []` — no projects configured, no todo routines, no CLIs detected) makes /v1/responses
return `status: "incomplete"`, `incomplete_details.reason: "max_output_tokens"`, **zero** tokens
used and an empty `output[]`. No error — just a chat turn that answers nothing and a spinner
that never resolves. chat.completions accepted the same schema. `stripEmptyEnums` in the
adapter removes those keys for every tool from every surface, and the adapter throws on an
incomplete response that produced no content and no tool call, so this class can never be
silent again. Found only by running the packaged app against the real API with an empty
`projects.json` — unit tests and the stubbed e2e suite both passed while it was broken.

**Also:** `converse()`'s chat-failure catch must keep reporting the underlying error message.
It used to swallow everything and print "check your API key", which sent a debugging session
after a perfectly good key while the real cause was this 400.
