import type { LiveCli, ProposedLiveSession } from "@bean/core";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";

/** Bean's offer to hand this chat to a live agent. `agent` is undefined when no live agent is
 * enabled (Start then can't run). The ask line is shown so the user sees what the agent gets. */
export function LiveOfferCard({
  offer,
  agent,
  projectName,
  state,
  onStart,
  onDismiss,
}: {
  offer: ProposedLiveSession;
  agent?: LiveCli;
  projectName: string;
  state: "pending" | "started" | "dismissed" | "expired";
  onStart: () => void;
  onDismiss: () => void;
}) {
  const done = state !== "pending";
  return (
    <div class="bean-card">
      <div class="bean-offer-title">
        {agent ? (
          <>
            <AgentAvatar agent={agent} size={16} />
            <span>This looks like a job for {AGENT_NAMES[agent]} in <em>{projectName}</em>. Hand over this chat?</span>
          </>
        ) : (
          <span>This looks like a job for a coding agent, but none is turned on in Settings.</span>
        )}
      </div>
      <div class="bean-offer-ask">{offer.instruction}</div>
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done || !agent} onClick={onStart}>
          {state === "started" ? "Started" : "Start"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "expired" ? "Expired" : "Not now"}
        </button>
      </div>
    </div>
  );
}
