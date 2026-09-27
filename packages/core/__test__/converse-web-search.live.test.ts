import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { converse } from "../src/converse.js";
import { makeOpenAIConverseWithClient } from "../src/openai-chat.js";
import { DEFAULT_PERSONA } from "../src/persona.js";

// Routing guardrails for web search, against the real model — the regression fence for edits
// to behaviorInstructions. A fake chat can't tell whether the model searches or hands off, so
// these only run when a key is given (each run is billed):
//   BEAN_LIVE_OPENAI_KEY=sk-... [BEAN_LIVE_MODEL=gpt-5.4-nano] pnpm --filter @bean/core exec vitest run converse-web-search.live
const key = process.env.BEAN_LIVE_OPENAI_KEY;
const model = process.env.BEAN_LIVE_MODEL ?? "gpt-4o-mini";

async function ask(text: string): Promise<{ searched: boolean; delegated: boolean; reply: string }> {
  const real = new OpenAI({ apiKey: key });
  let searched = false;
  const client = {
    responses: {
      create: async (args: never) => {
        const res = await real.responses.create(args);
        if (res.output.some((o) => o.type === "web_search_call")) searched = true;
        return res;
      },
    },
  };
  const res = await converse({
    history: [],
    latestUserText: text,
    skills: [],
    projects: [{ name: "bean", path: "/dev/bean" }],
    persona: DEFAULT_PERSONA,
    memories: [],
    deps: { model, chat: makeOpenAIConverseWithClient(client as never) },
    delegateAvailable: true,
    scratchPath: "/tmp/bean-scratch",
    runAvailable: false,
    webSearch: true,
  });
  return { searched, delegated: res.proposedDelegate !== undefined, reply: res.reply };
}

describe.skipIf(!key)(`web search routing guardrails (live, ${model})`, () => {
  it.each([
    ["create a Jira ticket for the login bug", { searched: false, delegated: true }],
    ["what's in my inbox from yesterday", { searched: false, delegated: true }],
    ["what's the latest Electron release", { searched: true, delegated: false }],
    ["summarize this paragraph: The meeting moved to Thursday because the venue flooded; " +
      "catering is unchanged and everyone should bring their own laptop.", { searched: false, delegated: false }],
  ])("%s", async (text, expected) => {
    const out = await ask(text);
    expect({ searched: out.searched, delegated: out.delegated }, out.reply).toEqual(expected);
  }, 90_000);
});
