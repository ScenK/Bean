import { expect, test } from "vitest";
import { composePrompt } from "../src/prompt.js";
import type { Skill } from "../src/types.js";

const skill: Skill = {
  name: "review-code",
  description: "Review a merge request",
  body: "# Review\nDo a thorough review.",
};

test("includes skill body and instruction", () => {
  const out = composePrompt(skill, "review MR 42");
  expect(out).toContain("Do a thorough review.");
  expect(out).toContain("review MR 42");
});

test("includes url when provided", () => {
  const out = composePrompt(skill, "look at this", "https://jira/X-1");
  expect(out).toContain("https://jira/X-1");
});

test("omits url section when absent", () => {
  const out = composePrompt(skill, "go");
  expect(out.toLowerCase()).not.toContain("context url");
});

test("omits the Task section when instruction is empty", () => {
  const out = composePrompt(skill, "");
  expect(out.toLowerCase()).not.toContain("## task");
  expect(out).toContain("Do a thorough review.");
});
