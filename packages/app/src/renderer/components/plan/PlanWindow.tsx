// packages/app/src/renderer/components/plan/PlanWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { ProposalCard, type PickableModel } from "../../shared/ProposalCard.js";
import type { Theme } from "../../../channels.js";
import type { CliName, Project, RouteSuggestion } from "@bean/core";

export function PlanWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [run, setRun] = useState<RouteSuggestion | undefined>(undefined);
  const [clis, setClis] = useState<CliName[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<PickableModel[]>([]);
  const [lastUsedModel, setLastUsedModel] = useState<string | undefined>(undefined);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    // Pull any plan proposed before this window's renderer finished loading — the push below
    // can arrive before we subscribe and get dropped, which used to leave "Waiting for a plan…"
    // stuck forever. onProposeRun still handles updates to an already-open window.
    window.bean.getPendingPlan().then((p) => { if (p) setRun(p); });
    window.bean.onProposeRun((suggestion) => setRun(suggestion));
    window.bean.availableClis().then(setClis);
    window.bean.listProjects().then(setProjects);
    window.bean.availableModels().then(setModels);
  }, []);

  // The "last used" badge is per-skill, so re-fetch whenever the proposed run's skill changes.
  useEffect(() => {
    if (!run) return;
    window.bean.getModelMemory(run.skillName).then(setLastUsedModel);
  }, [run?.skillName]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // The plan window is single-purpose: once you act on it (or bail with Escape), it's done.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") window.close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The projects this run could target: the ones the skill is assigned to, or — for a
  // general skill (no assignments) — every project. 2+ candidates puts a picker on the card.
  const projectOptions = run
    ? (() => {
        const assigned = projects.filter((p) => p.skills?.includes(run.skillName));
        return assigned.length > 0 ? assigned : projects;
      })()
    : [];

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
            cliOptions={clis}
            projectOptions={projectOptions}
            modelOptions={models}
            lastUsedModel={lastUsedModel}
            onConfirm={(edited, choice) => {
              if (choice.model) void window.bean.setModelMemory(run.skillName, choice.model);
              if (run.target === "chat") window.bean.runInChat(edited, run.skillName);
              else {
                window.bean.launch({
                  mode: choice.cli,
                  projectPath: choice.projectPath ?? "",
                  prompt: edited,
                  model: choice.model,
                });
              }
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
