import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { converse } from "../src/converse.js";
import { makeOpenAIConverseWithClient } from "../src/openai-chat.js";
import { DEFAULT_PERSONA } from "../src/persona.js";

// Wording guardrails for the desktop live-session offer (propose_live_session, liveSessionHost
// "desktop"), against the real model: a fake chat can't tell whether the model offers the
// hand-off. Same shape as converse-web-search.live.test.ts; each run is billed:
//   BEAN_LIVE_OPENAI_KEY=sk-... [BEAN_LIVE_MODEL=gpt-5.4-nano] pnpm --filter @bean/core exec vitest run converse-live-offer.live
const key = process.env.BEAN_LIVE_OPENAI_KEY;
const model = process.env.BEAN_LIVE_MODEL ?? "gpt-4o-mini";

async function ask(text: string): Promise<{ offered: boolean; reply: string }> {
  const res = await converse({
    history: [],
    latestUserText: text,
    skills: [],
    projects: [{ name: "bean", path: "/dev/bean" }],
    persona: DEFAULT_PERSONA,
    memories: [],
    deps: { model, chat: makeOpenAIConverseWithClient(new OpenAI({ apiKey: key }) as never) },
    delegateAvailable: true,
    scratchPath: "/tmp/bean-scratch",
    liveSessionAvailable: true,
    liveSessionHost: "desktop",
  });
  return { offered: res.proposedLiveSession !== undefined, reply: res.reply };
}

describe.skipIf(!key)(`desktop live-session offer guardrails (live, ${model})`, () => {
  it.each([
    ["Let's build OAuth login in bean together — add the provider config, the callback route and tests, and I'll steer as we go.", true],
    ["what does HTTP 418 mean?", false],
    ["rewrite this sentence to sound friendlier: Your request was denied.", false],
  ])("%s", async (text, offered) => {
    const out = await ask(text);
    expect(out.offered, out.reply).toBe(offered);
  }, 90_000);
});
