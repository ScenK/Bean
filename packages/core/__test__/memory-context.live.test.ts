import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../src/converse.js";
import { extractMemories } from "../src/memory/extract.js";
import { makeOpenAIConverseWithClient } from "../src/openai-chat.js";

// Does the extraction model write a usable `context` label (#856) when a typed fact's referent
// lives only in a non-citable line? A fake chat can't tell. Billed:
//   BEAN_LIVE_OPENAI_KEY=sk-... [BEAN_LIVE_MODEL=gpt-5.4-nano] pnpm --filter @bean/core exec vitest run memory-context.live
const key = process.env.BEAN_LIVE_OPENAI_KEY;
const model = process.env.BEAN_LIVE_MODEL ?? "gpt-4o-mini";

// Neutral shapes; `referent` = a word a usable label must carry.
const cases: { name: string; turns: ChatTurn[]; referent: RegExp }[] = [
  {
    name: "an answer to an agent's question",
    turns: [
      { role: "assistant", content: "Which environment does the checkout timeout reproduce in — production or staging?" },
      { role: "user", content: "Only in the staging cluster, and I'm still waiting on the infra team to look at it.", source: "typed" },
    ],
    referent: /checkout|timeout/i,
  },
  {
    name: "a group-chat line with an implied subject",
    turns: [
      { role: "user", content: "[Ana]: we're picking the color for the new garden shed this weekend", source: "ambient" },
      { role: "user", content: "Kind of want it to be blue, I'll decide by Sunday.", source: "typed" },
    ],
    referent: /shed/i,
  },
  {
    name: "a third party's product mention",
    turns: [
      { role: "assistant", content: "From the newsletter: Driftwood is a self-hosted tool for syncing calendar invites across accounts." },
      { role: "user", content: "I want to try Driftwood next month for my calendar mess.", source: "typed" },
    ],
    referent: /calendar|sync|invite/i,
  },
];

describe.skipIf(!key)(`memory context labels (live, ${model})`, () => {
  it("reports the share of cases that got a usable label", async () => {
    const deps = { model, chat: makeOpenAIConverseWithClient(new OpenAI({ apiKey: key }) as never) };
    let usable = 0;
    for (const c of cases) {
      const { candidates, failed } = await extractMemories(c.turns, [], [], deps, { latestTurn: true });
      expect(failed, c.name).toBe(false);
      const hit = candidates.some((m) => m.context && c.referent.test(m.context));
      if (hit) usable++;
      console.log(`${hit ? "✓" : "✗"} ${c.name}: ${JSON.stringify(candidates.map((m) => ({ text: m.text, context: m.context })))}`);
    }
    console.log(`usable context labels: ${usable}/${cases.length} (${Math.round((usable / cases.length) * 100)}%)`);
  }, 180_000);
});
