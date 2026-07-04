// packages/app/src/renderer/components/plan/PlanWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { ProposalCard } from "../../shared/ProposalCard.js";
import type { Theme } from "../../../channels.js";
import type { RouteSuggestion } from "@bean/core";

export function PlanWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [run, setRun] = useState<RouteSuggestion | undefined>(undefined);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    // Pull any plan proposed before this window's renderer finished loading — the push below
    // can arrive before we subscribe and get dropped, which used to leave "Waiting for a plan…"
    // stuck forever. onProposeRun still handles updates to an already-open window.
    window.bean.getPendingPlan().then((p) => { if (p) setRun(p); });
    window.bean.onProposeRun((suggestion) => setRun(suggestion));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // The plan window is single-purpose: once you act on it (or bail with Escape), it's done.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") window.close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div class="bean-dashboard">
      <div class="bean-plan">
        <div class="bean-plan-header">
          <span class="bean-plan-dot" />
          <span>Bean's plan</span>
        </div>
        {run ? (
          <ProposalCard
            run={run}
            state="pending"
            onConfirm={(edited) => {
              if (run.target === "chat") window.bean.runInChat(edited, run.skillName);
              else window.bean.launch({ mode: "opencode", projectPath: run.projectPath, prompt: edited });
              window.close();
            }}
            onCancel={() => window.close()}
          />
        ) : (
          <div class="bean-panel-empty">Waiting for a plan…</div>
        )}
      </div>
    </div>
  );
}
