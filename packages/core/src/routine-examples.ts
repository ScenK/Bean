// Node-free (renderer-safe, `@bean/core/routine-examples`): small starting-point flows the
// Routines panel offers instead of one fixed template. Each is created disabled, uses only the
// generic repo-shipped skills (.bean/skills/), and is meant to be reshaped or deleted.
import type { Routine } from "./routine-store.js";

export interface RoutineExample { key: string; label: string; blurb: string; routine: Routine }

// Generic watch commands: no board ids or org specifics. The issue body rides in the todo text
// so a chat-model lint step can read the ticket without a fetch.
const ISSUE_WATCH =
  "gh search issues --assignee=@me --label=bean --state=open --json number,title,url,body " +
  "--jq '.[] | {id: .url, text: \"\\(.title)\\n\\(.url)\\n\\n\\(.body)\"}'";
const PR_WATCH =
  "gh search prs --review-requested=@me --state=open --json title,url " +
  "--jq '.[] | {id: .url, text: \"\\(.title)\\n\\(.url)\"}'";

const issueWatch = { kind: "command" as const, command: ISSUE_WATCH, everyMinutes: 15 };

export const ROUTINE_EXAMPLES: RoutineExample[] = [
  {
    key: "dev-loop",
    label: "Dev loop",
    blurb: "implement → test ⟲ → review by another vendor ⟲ → PR",
    routine: {
      name: "dev-loop",
      description: "Implement a queued issue, loop on failing tests and review findings, then open a PR",
      enabled: false,
      watch: issueWatch,
      todoDriven: true,
      steps: [
        { kind: "delegate", id: "implement", skill: "implement", cli: "claude", instruction: "Implement the queued issue." },
        { kind: "command", id: "test", command: "npm test", gate: { onFail: { goto: "implement", maxRounds: 3 } } },
        { kind: "delegate", id: "review", skill: "review", cli: "codex", instruction: "Review the uncommitted and committed changes on this branch.", gate: { onFail: { goto: "implement", maxRounds: 3 } } },
        { kind: "delegate", id: "pr", skill: "pr", cli: "claude", instruction: "Open a pull request for this branch." },
      ],
      sinks: { notify: true },
    },
  },
  {
    key: "ticket-lint-first",
    label: "Ticket lint first",
    blurb: "lint (cheap chat model) → implement → test ⟲ → PR · vague tickets get a clarifying comment",
    routine: {
      name: "ticket-lint-first",
      description: "Check a queued issue is clear enough to build; ask on the ticket when it isn't",
      enabled: false,
      watch: issueWatch,
      todoDriven: true,
      steps: [
        { kind: "chat", id: "lint", skill: "ticket-lint", instruction: "Lint the queued issue.", gate: { onFail: { goto: "clarify" } } },
        { kind: "delegate", id: "implement", skill: "implement", cli: "claude", instruction: "Implement the queued issue." },
        { kind: "command", id: "test", command: "npm test", gate: { onFail: { goto: "implement", maxRounds: 3 } } },
        { kind: "delegate", id: "pr", skill: "pr", cli: "claude", instruction: "Open a pull request for this branch.", next: "end" },
        { kind: "delegate", id: "clarify", skill: "ask-on-ticket", cli: "claude", instruction: "Ask the questions the lint raised on the queued issue." },
      ],
      sinks: { notify: true },
    },
  },
  {
    key: "parallel-checks",
    label: "Parallel checks",
    blurb: "implement → lint ‖ test ‖ review at once → triage reads every result ⟲ → PR",
    routine: {
      name: "parallel-checks",
      description: "Implement a queued issue, run lint, tests and a review at the same time, then loop or open a PR",
      enabled: false,
      watch: issueWatch,
      todoDriven: true,
      steps: [
        { kind: "delegate", id: "implement", skill: "implement", cli: "claude", instruction: "Implement the queued issue." },
        { kind: "command", id: "lint", command: "npm run lint" },
        { kind: "command", id: "test", command: "npm test", alongside: true },
        { kind: "delegate", id: "review", skill: "review", cli: "codex", instruction: "Review the uncommitted and committed changes on this branch.", alongside: true },
        { kind: "chat", id: "triage", instruction: "Read the lint, test and review results. Pass only when all three are clean; otherwise list what to fix.", gate: { onFail: { goto: "implement", maxRounds: 3 } } },
        { kind: "delegate", id: "pr", skill: "pr", cli: "claude", instruction: "Open a pull request for this branch." },
      ],
      sinks: { notify: true },
    },
  },
  {
    key: "review-only",
    label: "Review only",
    blurb: "review PRs waiting on you · stop on FAIL → notify",
    routine: {
      name: "review-only",
      description: "Review pull requests that request your review and tell you the outcome",
      enabled: false,
      watch: { kind: "command", command: PR_WATCH, everyMinutes: 15 },
      todoDriven: true,
      steps: [
        { kind: "delegate", id: "review", skill: "review", instruction: "Review the queued pull request (read-only: don't comment, approve, or push).", gate: { onFail: "stop" } },
        { kind: "chat", id: "notify", instruction: "Summarize the review in two or three lines: the PR, and why it looks ready to approve." },
      ],
      sinks: { notify: true },
    },
  },
  {
    key: "triage",
    label: "Triage an incoming item",
    blurb: "triage (chat) → bug: implement → PR · question: draft an answer · otherwise: end",
    routine: {
      name: "triage",
      description: "Sort a queued issue into a bug fix, a question to answer, or nothing to do",
      enabled: false,
      watch: issueWatch,
      todoDriven: true,
      steps: [
        {
          kind: "chat", id: "triage",
          instruction: "Triage the queued issue. bug = it reports something broken that code can fix; question = it asks how something works or what to do. Anything else needs no action.",
          route: { paths: [{ when: "bug", goto: "implement" }, { when: "question", goto: "answer" }], otherwise: "end" },
        },
        { kind: "delegate", id: "implement", skill: "implement", cli: "claude", instruction: "Fix the bug in the queued issue." },
        { kind: "delegate", id: "pr", skill: "pr", cli: "claude", instruction: "Open a pull request for this branch.", next: "end" },
        { kind: "chat", id: "answer", instruction: "Draft a short, plain answer to the question in the queued issue.", next: "end" },
      ],
      sinks: { notify: true },
    },
  },
  {
    key: "sdlc-retro",
    label: "SDLC retro",
    blurb: "weekly: read dev-loop's recent runs → draft skill fixes for you to review",
    routine: {
      name: "sdlc-retro",
      description: "Read the dev loop's recent runs and draft skill improvements (never applies them)",
      enabled: false,
      cron: "0 9 * * 1",
      steps: [
        { kind: "chat", id: "retro", skill: "retro", instruction: 'Review the recent runs of the sprout "dev-loop" and draft skill improvements.' },
      ],
      sinks: { notify: true },
    },
  },
];

/** A fresh copy of an example, renamed `<name>-2`, `-3`, … when the name is taken — saving
 * under an existing name would overwrite that routine. */
export function exampleRoutine(example: RoutineExample, taken: string[]): Routine {
  const routine = structuredClone(example.routine);
  let name = routine.name;
  for (let n = 2; taken.includes(name); n++) name = `${routine.name}-${n}`;
  return { ...routine, name };
}
