import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { synthesizeEpisode, type EpisodeLine } from "../src/memory/extract.js";
import { makeOpenAIConverseWithClient } from "../src/openai-chat.js";

// Does the real model hold the episode bar (.memory/project-episode-memory.md)? A fake chat can't
// tell: noise must yield nothing, and what matters must come out self-contained. Billed:
//   BEAN_LIVE_OPENAI_KEY=sk-... [BEAN_LIVE_MODEL=gpt-5.4-nano] pnpm --filter @bean/core exec vitest run memory-episode.live
const key = process.env.BEAN_LIVE_OPENAI_KEY;
const model = process.env.BEAN_LIVE_MODEL ?? "gpt-4o-mini";
const NOW = new Date("2026-11-18T15:00:00-08:00");
const CHAT = "This is your owner's own conversation with you (lines from You are your owner's; Bean is you).";
const GROUP = "This is a group chat nobody addressed you in. Lines marked (owner) are your owner's.";

// `keep` absent = the episode is noise and must save nothing; else every saved memory must match
// it, at least one must be saved, and `dated` asks for an `expires`.
const cases: { name: string; audience: string; lines: EpisodeLine[]; keep?: RegExp; dated?: boolean }[] = [
  { name: "a bare acknowledgement", audience: CHAT, lines: [{ who: "Bean", text: "The build finished." }, { who: "You", text: "OK" }] },
  { name: "a one-off request", audience: CHAT, lines: [{ who: "You", text: "Set a reminder at 2:20 PM." }, { who: "Bean", text: "Done — 2:20 PM." }] },
  { name: "a question", audience: CHAT, lines: [{ who: "You", text: "What would we gain from the Teams SDK? Would we have to rewrite the bot?" }] },
  {
    name: "someone else's status line", audience: GROUP,
    lines: [{ who: "Scen (owner)", text: "Could you enable the messaging feature flag?" }, { who: "Nik", text: "Done." }],
  },
  {
    name: "an OK that accepts an invitation", audience: GROUP, keep: /2026-11-19|Nov(ember)? 19/i, dated: true,
    lines: [
      { who: "Scen (owner)", text: "Busy lately, but I want to get out." },
      { who: "Nik", text: "Then let's go out tomorrow around 3pm — meet at the trailhead?" },
      { who: "Scen (owner)", text: "OK" },
    ],
  },
  {
    // The rule for next time, not this task's ticket numbers.
    name: "a correction that is really a rule", audience: CHAT, keep: /^(?!.*38802)(?=.*branch)/i,
    lines: [
      { who: "You", text: "codex review, then commit on branches" },
      { who: "Bean", text: "Committed on IT-38650 and cherry-picked the fix onto IT-38802, IT-38804 and IT-38805." },
      { who: "You", text: "Wait, you only need to work on the 38650 branch, the other branches are all closed." },
    ],
  },
  { name: "a lasting fact", audience: CHAT, keep: /Camas/, lines: [{ who: "You", text: "We moved to Camas, Washington last month, so use Pacific time for me." }] },
];

describe.skipIf(!key)("episode synthesis (live model)", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const chat = makeOpenAIConverseWithClient(new OpenAI({ apiKey: key }) as never);
      const r = await synthesizeEpisode({ lines: c.lines, firstNew: 0, existing: [], projects: [], audience: c.audience, now: NOW }, { chat, model });
      expect(r.failed).toBe(false);
      console.log(`${c.name}: ${JSON.stringify(r.candidates.map((m) => [m.text, m.expiresAt ?? null]))}`);
      if (!c.keep) return void expect(r.candidates).toEqual([]);
      expect(r.candidates.length).toBeGreaterThan(0);
      for (const m of r.candidates) expect(m.text).toMatch(c.keep);
      if (c.dated) expect(r.candidates.some((m) => m.expiresAt)).toBe(true);
    }, 60_000);
  }
});
