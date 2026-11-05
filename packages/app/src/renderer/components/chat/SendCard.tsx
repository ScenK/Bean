import { useEffect, useState } from "preact/hooks";
import type { ChatopsSurface, SendCard as SendProposal } from "@bean/core";

const PLATFORM: Record<ChatopsSurface, string> = { discord: "Discord", teams: "Teams" };

/** propose_send confirm card: pick the destination (pre-selected only on a confident match), see
 * the body exactly as it will post, then Send. Main holds the body and the rows; Send hands back
 * only the card id and the picked option id. */
export function SendCard({
  card,
  state,
  onSend,
  onDismiss,
}: {
  card: SendProposal;
  state: "pending" | "sending" | "sent" | "dismissed" | "expired";
  onSend: (optionId: string) => void;
  onDismiss: () => void;
}) {
  const [pick, setPick] = useState(card.pick ?? "");
  const [botOn, setBotOn] = useState<Partial<Record<ChatopsSurface, boolean>>>({});
  useEffect(() => {
    window.bean.chatopsStatus().then((st) => {
      if (st) setBotOn({ discord: st.discord.running, teams: st.teams.running });
    }, () => {});
  }, []);
  const chosen = card.options.find((o) => o.id === pick);
  const open = state === "pending";
  const groups = (["discord", "teams"] as const)
    .map((surface) => ({ surface, options: card.options.filter((o) => o.surface === surface) }))
    .filter((g) => g.options.length > 0);
  return (
    <div class="bean-card bean-send-card">
      <div class="bean-card-chips">
        <span class="bean-chip">Send a message</span>
      </div>
      <label class="bean-send-pick">
        <span class="bean-offer-ask">{`To "${card.destination}"`}</span>
        <select
          class="bean-send-select"
          aria-label="Destination"
          value={pick}
          disabled={!open}
          onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">{card.options.length ? "Pick a conversation…" : "No named conversations yet"}</option>
          {groups.map((g) => (
            <optgroup key={g.surface} label={PLATFORM[g.surface]}>
              {g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {chosen && (
        <div class="bean-send-target">
          <strong>{chosen.label}</strong>
          <span class="bean-offer-ask">{[PLATFORM[chosen.surface], chosen.detail].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      <div class="bean-card-prompt bean-send-body">{card.body}</div>
      <div class="bean-offer-ask">Posts as Bean</div>
      {chosen && botOn[chosen.surface] === false && (
        <div class="bean-offer-ask" role="note">{`The ${PLATFORM[chosen.surface]} bot is off — this posts when it starts.`}</div>
      )}
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={!open || !chosen} onClick={() => onSend(pick)}>
          {state === "sending" ? "Sending…" : state === "sent" ? "Queued" : "Send"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={!open} onClick={onDismiss}>
          {state === "dismissed" ? "Cancelled" : state === "expired" ? "Expired" : "Cancel"}
        </button>
      </div>
      <div class="bean-offer-ask bean-send-footer">Missing one? Name it in Settings → ChatOps.</div>
    </div>
  );
}
