import { useState } from "preact/hooks";
import type { ProposalOutcome } from "@bean/core";
import type { SkillProposalView } from "../../../ipc.js";
import { lineDiff } from "./line-diff.js";

export interface ProposalLists {
  pending: SkillProposalView[];
  applied: SkillProposalView[];
}

const REFUSED: Record<Exclude<ProposalOutcome, { ok: true }>["reason"], string> = {
  gone: "Already handled — refreshed.",
  stale: "Stale — the skill changed since this proposal was drafted.",
  changed: "Can't undo — the skill was edited after this was approved.",
};

/** The Skills panel's retro inbox (#263): review a drafted skill edit as a full-file diff, then
 * approve (stale-checked in main), reject, or undo a recent approve. */
export function ProposalsInbox({ proposals, onChanged }: { proposals: ProposalLists; onChanged: () => Promise<void> }) {
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const act = async (id: string, run: () => Promise<ProposalOutcome>, done?: string): Promise<void> => {
    setBusy(id);
    try {
      const outcome = await run();
      setNotice((n) => ({ ...n, [id]: outcome.ok ? (done ?? "") : REFUSED[outcome.reason] }));
    } catch (err) {
      setNotice((n) => ({ ...n, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(undefined);
      await onChanged();
    }
  };

  // Regenerate = archive this draft and re-run the retro routine against the current skill.
  const regenerate = (p: SkillProposalView): Promise<void> => act(p.id, async () => {
    const outcome = await window.bean.skillProposalsReject(p.id);
    if (outcome.ok) {
      const run = await window.bean.routinesRunNow(p.routine);
      if (!run.started) throw new Error(`Rejected, but couldn't re-run "${p.routine}": ${run.reason ?? "unknown reason"}`);
    }
    return outcome;
  });

  if (proposals.pending.length === 0 && proposals.applied.length === 0) {
    return <div class="bean-panel-empty">No skill proposals. A retro routine drafts them from recent runs.</div>;
  }

  return (
    <div class="bean-proposals">
      <div class="bean-launch-label">SKILL PROPOSALS · {proposals.pending.length}</div>
      {proposals.pending.map((p) => (
        <div key={p.id} class="bean-proposal">
          <div class="bean-proposal-head">
            <span class="bean-skills-title">{p.skill}</span>
            <span class="bean-skills-description">from {p.routine} · {new Date(p.createdAt).toLocaleString()}</span>
          </div>
          <div class="bean-proposal-rationale">{p.rationale}</div>
          <div class="bean-skills-row-chips">
            {p.evidence.map((runId) => (
              <button
                key={runId}
                type="button"
                class="bean-skills-tag bean-proposal-evidence"
                title="Open the Dashboard to inspect this run"
                onClick={() => void window.bean.openComponent("dashboard")}
              >
                run {runId.slice(0, 8)}
              </button>
            ))}
          </div>
          <pre class="bean-proposal-diff" aria-label={`Changes to ${p.skill}.md`}>
            {lineDiff(p.current ?? "", p.body.trim() + "\n").map((l, i) => (
              <div key={i} class={l.op === "+" ? "bean-diff-add" : l.op === "-" ? "bean-diff-del" : "bean-diff-same"}>
                {l.op} {l.text}
              </div>
            ))}
          </pre>
          {p.stale ? <div class="bean-skills-notice">{REFUSED.stale}</div> : null}
          {notice[p.id] ? <div class="bean-skills-error">{notice[p.id]}</div> : null}
          <div class="bean-card-actions">
            {p.stale ? (
              <button type="button" class="bean-btn" disabled={busy === p.id} onClick={() => void regenerate(p)}>Regenerate</button>
            ) : (
              <button type="button" class="bean-btn" disabled={busy === p.id} onClick={() => void act(p.id, () => window.bean.skillProposalsApprove(p.id))}>
                Approve
              </button>
            )}
            <button type="button" class="bean-btn bean-btn--ghost" disabled={busy === p.id} onClick={() => void act(p.id, () => window.bean.skillProposalsReject(p.id))}>
              Reject
            </button>
          </div>
        </div>
      ))}
      {proposals.applied.length > 0 ? (
        <>
          <div class="bean-launch-label">RECENTLY APPROVED</div>
          {proposals.applied.map((p) => (
            <div key={p.id} class="bean-proposal bean-proposal--applied">
              <div class="bean-proposal-head">
                <span class="bean-skills-title">{p.skill}</span>
                <span class="bean-skills-description">{p.rationale}</span>
              </div>
              {notice[p.id] ? <div class="bean-skills-error">{notice[p.id]}</div> : null}
              <div class="bean-card-actions">
                <button type="button" class="bean-btn bean-btn--ghost" disabled={busy === p.id} onClick={() => void act(p.id, () => window.bean.skillProposalsUndo(p.id))}>
                  Undo
                </button>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
