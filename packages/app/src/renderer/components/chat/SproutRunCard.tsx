import type { SproutRunPlan } from "@bean/core";

/** "Run the X sprout" confirm card (modeled on TodoCard): what a tap does, where results go,
 * and the outcome in place once it settles. */
export function SproutRunCard({
  plan,
  state,
  result,
  onTrigger,
  onDismiss,
}: {
  plan: SproutRunPlan;
  state: "pending" | "running" | "done" | "dismissed" | "expired";
  result?: string;
  onTrigger: () => void;
  onDismiss: () => void;
}) {
  const check = plan.action === "check";
  const primary = state === "running" ? (check ? "Checking…" : "Running…") : check ? "Check now" : "Run";
  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">{`Sprout "${plan.routine}"`}</span>
        {plan.paused && <span class="bean-chip">Paused · runs once</span>}
      </div>
      <div class="bean-offer-title">{plan.actionLine}</div>
      <div class="bean-offer-ask">{`Results go to ${plan.resultsTo}`}</div>
      {result !== undefined && <div class="bean-offer-ask" role="status">{result}</div>}
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={state !== "pending"} onClick={onTrigger}>{primary}</button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={state !== "pending"} onClick={onDismiss}>
          {state === "dismissed" ? "Cancelled" : state === "expired" ? "Expired" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
