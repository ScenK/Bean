import type { RoutineDraftCard as RoutineDraft } from "@bean/core";

export type RoutineDraftState = "pending" | "sending" | "saved" | "dismissed" | "expired";

/** The header line for what Save does to an existing sprout of the same name. */
export function draftReplaceLine(card: Pick<RoutineDraft, "name" | "replaces">): string | undefined {
  if (card.replaces === "archived") return `Replaces archived «${card.name}»`;
  if (card.replaces === "paused") return `Replaces «${card.name}» and turns it back on`;
  if (card.replaces === "live") return `Replaces «${card.name}»`;
  return undefined;
}

/** propose_routine confirm card (#982): what Bean watches for, how, where it tells you and when it
 * stops. Main keeps the draft; Save / Open in editor hand back only the card id. */
export function RoutineDraftCard({
  card,
  state,
  onSave,
  onEdit,
  onDismiss,
}: {
  card: RoutineDraft;
  state: RoutineDraftState;
  onSave: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}) {
  const open = state === "pending";
  const replace = draftReplaceLine(card);
  const rows: Array<[string, string[]]> = card.problem ? [] : [
    ...(card.ask ? [[card.commitment ? "Watch for" : "About", [card.ask]] as [string, string[]]] : []),
    ["How", card.how],
    ["Tell you", card.tellYou],
    ...(card.stops ? [["Stops", [card.stops]] as [string, string[]]] : []),
  ];
  return (
    <div class="bean-card bean-routine-draft">
      <div class="bean-card-chips">
        <span class="bean-chip">Sprout</span>
        <span class="bean-chip">{card.name}</span>
      </div>
      {replace && <div class="bean-offer-ask" role="note">{replace}</div>}
      {card.problem
        ? <div class="bean-offer-ask" role="alert">{`Can't save: ${card.problem}`}</div>
        : (
          <dl class="bean-routine-draft-rows">
            {rows.map(([label, lines]) => (
              <div key={label} class="bean-routine-draft-row">
                <dt>{label}</dt>
                {lines.map((l, i) => <dd key={i}>{l}</dd>)}
              </div>
            ))}
          </dl>
        )}
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={!open || card.problem !== undefined} onClick={onSave}>
          {state === "sending" ? "Saving…" : state === "saved" ? "Saved" : "Save"}
        </button>
        <button
          type="button"
          class="bean-btn bean-btn--ghost"
          disabled={!open || card.problem !== undefined}
          title="Saves it switched off, then opens Sprouts"
          onClick={onEdit}
        >
          Open in editor
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={!open} onClick={onDismiss}>
          {state === "dismissed" ? "Cancelled" : state === "expired" ? "Expired" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
