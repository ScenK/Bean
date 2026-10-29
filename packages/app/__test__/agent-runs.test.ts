import { expect, test } from "vitest";
import { itemAgent, startsAgentRun, type AgentId, type ChatItem } from "../src/renderer/shared/chat-types.js";

const reply = (id: string, agent?: AgentId): ChatItem =>
  ({ kind: "reply", id, text: id, agent });

test("items without an agent are Bean's; non-bubble items have no agent", () => {
  expect(itemAgent(reply("r"))).toBe("bean");
  expect(itemAgent({ kind: "working", id: "w", text: "…", agent: "codex" })).toBe("codex");
  expect(itemAgent({ kind: "user", id: "u", text: "hi" })).toBeUndefined();
});

test("one avatar per run of consecutive same-agent bubbles", () => {
  const items: ChatItem[] = [
    reply("a"),
    reply("b", "bean"), // same run as an agent-less reply
    reply("c", "claude"), // agent change starts a run
    reply("d", "claude"),
    { kind: "status", id: "s", text: "note", tone: "info" }, // anything else ends the run
    reply("e", "claude"),
    { kind: "user", id: "u", text: "hi" },
    { kind: "working", id: "w", text: "…" },
  ];
  expect(items.map((_, i) => startsAgentRun(items, i))).toEqual([true, false, true, false, false, true, false, true]);
});
