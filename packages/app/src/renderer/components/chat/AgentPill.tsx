import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AvailableModel, LiveCli, Project } from "@bean/core";
import { effortLabel } from "@bean/core/models";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import { ModelEffortMenu } from "../../shared/ModelEffortMenu.js";
import type { AgentId } from "../../shared/chat-types.js";
import { agentModels, isLiveAgent } from "./agent-mode.js";

const GAP = 6;
const VIEWPORT_MARGIN = 8;

type Segment = "agent" | "project" | "model";

/**
 * The chat composer's unified agent pill: visually one single bordered pill with `·` separators,
 * logically split into independent interactive segments:
 * - Bean mode: `[ 🫘 Bean ▾ ]` (no Project — Bean's brain has no filesystem).
 * - Agent mode: `[ ✦ Claude Code · Bean · opus · High ▾ ]` — clicking each segment opens only its
 *   own focused popover (Agent / Project / combined Model + Effort).
 */
export function AgentPill({
  disabled,
  mode,
  liveAgents,
  projects,
  agentProject,
  runModels,
  model,
  effort,
  live,
  onPickAgent,
  onPickProject,
  onPickModel,
  onPickEffort,
}: {
  disabled?: boolean;
  mode: AgentId;
  liveAgents: readonly LiveCli[];
  projects: readonly Project[];
  agentProject: string;
  runModels: readonly AvailableModel[];
  /** Effective model id (live session's model, or next fresh start's model). */
  model?: string;
  /** Effective effort level (live session's effort, or next fresh start's effort). */
  effort?: string;
  live?: { projectPath: string; model?: string; effort?: string };
  onPickAgent: (agent: AgentId) => void;
  onPickProject: (path: string) => void;
  onPickModel: (model: string) => void;
  onPickEffort: (effort: string) => void;
}) {
  const [open, setOpen] = useState<Segment | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const agentBtnRef = useRef<HTMLButtonElement>(null);
  const projectBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | undefined>(undefined);

  const agentMode = isLiveAgent(mode);
  const models = agentMode ? agentModels(runModels, mode) : [];
  const shownProjectPath = live?.projectPath ?? agentProject;
  const projectName = projects.find((p) => p.path === shownProjectPath)?.name ?? "scratch";
  const modelLabel = model ? (runModels.find((m) => m.id === model)?.label ?? model) : undefined;
  const hasModelSegment = agentMode && (models.length > 0 || !!modelLabel);

  // If mode switches back to Bean while Project/Model popover was open, close it.
  useEffect(() => {
    if (!agentMode && (open === "project" || open === "model")) setOpen(null);
  }, [agentMode, open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(null); }
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const anchorFor = (seg: Segment | null): HTMLElement | null => {
    if (seg === "project") return projectBtnRef.current;
    if (seg === "model") return modelBtnRef.current;
    return agentBtnRef.current;
  };

  useLayoutEffect(() => {
    if (!open) { setPos(undefined); return; }
    const reposition = (): void => {
      const trigger = anchorFor(open) ?? rootRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const panelHeight = panel.offsetHeight;
      const panelWidth = panel.offsetWidth;
      const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - GAP - VIEWPORT_MARGIN;
      const openUp = panelHeight > spaceBelow && spaceAbove > spaceBelow;
      const avail = openUp ? spaceAbove : spaceBelow;
      const maxHeight = Math.max(120, Math.min(panelHeight, avail));
      const left = Math.min(
        Math.max(rect.left, VIEWPORT_MARGIN),
        window.innerWidth - panelWidth - VIEWPORT_MARGIN,
      );
      const top = openUp ? rect.top - GAP - maxHeight : rect.bottom + GAP;
      setPos({ top, left, maxHeight });
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open, mode, model, effort, models.length, projects.length]);

  const toggle = (seg: Segment): void => {
    if (disabled) return;
    setOpen((cur) => (cur === seg ? null : seg));
  };

  const close = (): void => setOpen(null);

  return (
    <div class="bean-chip-menu" ref={rootRef}>
      <div class={`bean-agent-chip bean-agent-pill${disabled ? " bean-agent-pill--disabled" : ""}${open ? " bean-agent-pill--open" : ""}`}>
        <button
          ref={agentBtnRef}
          type="button"
          class={`bean-agent-seg bean-agent-seg--agent${open === "agent" ? " bean-agent-seg--on" : ""}`}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open === "agent"}
          onClick={() => toggle("agent")}
        >
          <AgentAvatar agent={mode} size={16} />
          <span class="bean-agent-seg-text">{AGENT_NAMES[mode]}</span>
          {!agentMode ? <>{" "}<span class="bean-chip-menu-caret">{open === "agent" ? "▴" : "▾"}</span></> : null}
        </button>
        {agentMode ? (
          <>
            <span class="bean-agent-sep" aria-hidden="true"> · </span>
            <button
              ref={projectBtnRef}
              type="button"
              class={`bean-agent-seg bean-agent-seg--project${open === "project" ? " bean-agent-seg--on" : ""}`}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={open === "project"}
              aria-label={`Project: ${projectName}`}
              title={`Project: ${projectName}`}
              onClick={() => toggle("project")}
            >
              <span class="bean-agent-seg-text">{projectName}</span>
              {!hasModelSegment ? <>{" "}<span class="bean-chip-menu-caret">{open ? "▴" : "▾"}</span></> : null}
            </button>
          </>
        ) : null}
        {hasModelSegment ? (
          <>
            <span class="bean-agent-sep" aria-hidden="true"> · </span>
            <button
              ref={modelBtnRef}
              type="button"
              class={`bean-agent-seg bean-agent-seg--model${open === "model" ? " bean-agent-seg--on" : ""}${live ? " bean-agent-seg--locked" : ""}`}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={open === "model"}
              aria-label={`Model: ${modelLabel ?? "default"}${effort ? `, effort ${effortLabel(effort)}` : ""}`}
              title={live ? "End session to change model" : undefined}
              onClick={() => toggle("model")}
            >
              <span class="bean-agent-seg-text">
                {modelLabel ?? "CLI default"}{effort ? ` · ${effortLabel(effort)}` : ""}
              </span>{" "}
              <span class="bean-chip-menu-caret">{open ? "▴" : "▾"}</span>
            </button>
          </>
        ) : null}
      </div>

      {open ? (
        <div
          ref={panelRef}
          class="bean-chip-menu-panel"
          style={{
            visibility: pos ? "visible" : "hidden",
            top: pos ? `${pos.top}px` : 0,
            left: pos ? `${pos.left}px` : 0,
            maxHeight: pos ? `${pos.maxHeight}px` : undefined,
          }}
        >
          {open === "agent" ? (
            <div class="bean-chip-menu-list">
              {(["bean", ...liveAgents] as AgentId[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  class={`bean-chip-menu-row${a === mode ? " bean-chip-menu-row--on" : ""}`}
                  onClick={() => { onPickAgent(a); close(); }}
                >
                  <span class="bean-chip-menu-row-title"><AgentAvatar agent={a} size={16} /> {AGENT_NAMES[a]}</span>
                </button>
              ))}
            </div>
          ) : open === "project" ? (
            <div class="bean-chip-menu-list">
              <div class="bean-chip-menu-hint">Project</div>
              {[{ path: "", name: "No project — scratch workspace" }, ...projects].map((p) => (
                <button
                  key={p.path || "__scratch__"}
                  type="button"
                  class={`bean-chip-menu-row${p.path === shownProjectPath ? " bean-chip-menu-row--on" : ""}${p.path ? "" : " bean-chip-menu-row--no-project"}`}
                  onClick={() => { onPickProject(p.path); close(); }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          ) : agentMode ? (
            <ModelEffortMenu
              models={models}
              cli={mode}
              selectedModel={model}
              selectedEffort={effort}
              disabled={!!live}
              headerHint={live ? "Model · End session to change model" : "Model"}
              onPickModel={(id) => { if (id) onPickModel(id); }}
              onPickEffort={(eff) => { if (eff) onPickEffort(eff); }}
              close={close}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
