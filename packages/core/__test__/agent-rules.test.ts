import { expect, test } from "vitest";
import {
  AGENT_RULES, REPO_PRECEDENCE, GIT_TRAILER_INSTRUCTION, FAILED_SENTINEL_INSTRUCTION, withCliRules,
} from "../src/agent-rules.js";
import { makeOpenAIConverseWithClient } from "../src/openai-chat.js";

test("withCliRules appends rules, precedence, trailer, then the sentinel for delegates only", () => {
  const rules = `\n\n${AGENT_RULES}\n\n${REPO_PRECEDENCE}${GIT_TRAILER_INSTRUCTION}`;
  expect(withCliRules("do it", "delegate")).toBe(`do it${rules}${FAILED_SENTINEL_INSTRUCTION}`);
  expect(withCliRules("do it", "live")).toBe(`do it${rules}`);
  expect(withCliRules("do it", "live")).not.toContain("FAILED:");
});

test("the moved trailer and sentinel stay byte-identical", () => {
  expect(GIT_TRAILER_INSTRUCTION).toBe(
    "\n\nIf this task involves a git commit, append this trailer to the commit message: Co-Authored-By: Bean <bean@localhost>");
  expect(FAILED_SENTINEL_INSTRUCTION).toBe(
    "\n\nIf you could not fully complete the task — including when browser tools are missing or the " +
    "browser isn't reachable, or when you would need to ask the user anything (permission, login, " +
    "which browser) — your final message's first line must be `FAILED: <one-line reason>`. " +
    "A headless run ends when you answer; there are no background retries.");
});

test("every brain request carries AGENT_RULES as instructions, input unchanged", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const client = { responses: { create: async (args: Record<string, unknown>) => { seen.push(args); return { output: [] }; } } };
  const chat = makeOpenAIConverseWithClient(client as never);
  await chat({ model: "m", messages: [{ role: "system", content: "persona" }, { role: "user", content: "hi" }], tools: [] });
  await chat({ model: "m", messages: [{ role: "tool", content: "ok", toolCallId: "c1" }], tools: [] });
  expect(seen.map((a) => a.instructions)).toEqual([AGENT_RULES, AGENT_RULES]);
  expect(seen[0]?.input).toEqual([{ role: "system", content: "persona" }, { role: "user", content: "hi" }]);
});
