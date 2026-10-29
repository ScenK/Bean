import type { JSX } from "preact";
import type { AgentId } from "./chat-types.js";

export const AGENT_NAMES: Record<AgentId, string> = {
  bean: "Bean",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
};

// Original Bean-drawn mascots that nod to each provider — never official logos. Same line idiom
// as avatar.ts's petal icons (24-unit box, stroke-width 2, round caps). Body = the agent's
// `--bean-agent-*` token as fill and outline (3:1 on every surface, theme-contrast.test.ts);
// features are drawn in `--bean-surface`, so the same guard keeps them 3:1 against the body.
const BODY = { fill: "var(--bean-agent-fill)", stroke: "var(--bean-agent-fill)" };
const FEATURE = { fill: "none", stroke: "var(--bean-surface)" };
const EYE = { fill: "var(--bean-surface)", stroke: "none" };

const MASCOTS: Record<AgentId, () => JSX.Element> = {
  // A bean with a smile.
  bean: () => (
    <>
      <path {...BODY} d="M8 4.5c3.5-2 9-.5 10.5 4s.5 10-4 11.5S6 20 4.5 16 4 6.8 8 4.5z" />
      <circle {...EYE} cx="9.5" cy="11" r="1.4" />
      <circle {...EYE} cx="14.5" cy="11" r="1.4" />
      <path {...FEATURE} d="M9.5 14.5q2.5 2 5 0" />
    </>
  ),
  // A little coral crab: two raised claws over a round body.
  claude: () => (
    <>
      <path {...BODY} d="M7 12 5 8.5M17 12l2-3.5M6.5 18.5 4.5 20.5M17.5 18.5l2 2" />
      <circle {...BODY} cx="4.5" cy="6.5" r="2" />
      <circle {...BODY} cx="19.5" cy="6.5" r="2" />
      <ellipse {...BODY} cx="12" cy="15" rx="6.5" ry="4.5" />
      <circle {...EYE} cx="9.8" cy="14" r="1.3" />
      <circle {...EYE} cx="14.2" cy="14" r="1.3" />
    </>
  ),
  // A green terminal critter: a screen body with a prompt for a face, on two little feet.
  codex: () => (
    <>
      <path {...BODY} d="M8.5 19v2.5M15.5 19v2.5" />
      <rect {...BODY} x="3" y="4.5" width="18" height="14.5" rx="3.5" />
      <path {...FEATURE} d="m7.5 9.5 3 2.25-3 2.25M12.5 15h4" />
    </>
  ),
  // A bracket bot: antenna head with `< >` for eyes.
  opencode: () => (
    <>
      <path {...BODY} d="M12 6.5V3.5" />
      <circle {...BODY} cx="12" cy="2.75" r="1" />
      <rect {...BODY} x="4" y="6.5" width="16" height="14" rx="3" />
      <path {...FEATURE} d="M10 10.5 8 13.5l2 3M14 10.5l2 3-2 3" />
    </>
  ),
};

/** Decorative mascot (aria-hidden) — the speaker's name rides on the bubble as hidden text. */
export function AgentAvatar({ agent, size = 24, bob = false }: { agent: AgentId; size?: 16 | 24; bob?: boolean }) {
  const Mascot = MASCOTS[agent];
  return (
    <svg
      class={`bean-agent-avatar bean-agent-avatar--${agent}${bob ? " bean-agent-avatar--bob" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <Mascot />
    </svg>
  );
}
