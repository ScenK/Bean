import { useEffect, useMemo, useState } from "preact/hooks";
import type { Project, LaunchMode, Routine, Skill } from "@bean/core";
import { projectsByName } from "@bean/core/project-select";
import { truncateMiddle } from "./truncate-path.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import { copyPath, useCapabilities } from "../../shared/capabilities.js";
import { countOf, sproutsByProject, withProjectSkill } from "./project-members.js";

const LAUNCH_CHIPS: { mode: LaunchMode; label: string; needsPrompt: boolean }[] = [
  { mode: "opencode", label: "opencode", needsPrompt: true },
  { mode: "claude", label: "claude", needsPrompt: true },
  { mode: "codex", label: "codex", needsPrompt: true },
  { mode: "agy", label: "agy", needsPrompt: true },
  { mode: "open", label: "Open in Editor", needsPrompt: false },
];

type FormState = { name: string; path: string };
const EMPTY_FORM: FormState = { name: "", path: "" };


export function ProjectsPanel({
  onLaunch,
}: {
  onLaunch: (mode: LaunchMode, project: Project, prompt?: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  // `undefined` = the core can't list sprouts (a remote core): the SPROUTS section is omitted.
  const [routines, setRoutines] = useState<Routine[] | undefined>(undefined);
  const { clis } = useCliAvailability();
  // A remote core (#812): no folder picker, Finder or Terminal hand-off across machines — the path is
  // typed and the core checks it.
  const caps = useCapabilities();
  const pickFolder = caps.has("pathOpen");
  const handoff = caps.has("terminalHandoff");
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [formMode, setFormMode] = useState<LaunchMode | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  // `original` tracks the path being edited (undefined = adding a new project) so save
  // can replace the right entry even if the user changes the path in the form.
  const [editing, setEditing] = useState<{ original: string | undefined; form: FormState } | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    setProjects(await window.bean.listProjects());
  };

  useEffect(() => {
    void refresh();
    window.bean.listSkills().then(setSkills, () => {});
    window.bean.routinesList().then((rs) => setRoutines(Array.isArray(rs) ? rs : undefined), () => {});
  }, []);

  const sprouts = useMemo(() => (routines ? sproutsByProject(routines, projects) : undefined), [routines, projects]);

  // Re-reads the registry first so a concurrent write (the Skills window's chips) isn't lost.
  const setProjectSkill = async (path: string, skill: string, on: boolean): Promise<void> => {
    try {
      await window.bean.saveProjects(withProjectSkill(await window.bean.listProjects(), path, skill, on));
      setSaveError(undefined);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedProject = projects.find((p) => p.path === selected);
  const chips = LAUNCH_CHIPS.filter((c) => c.mode === "open" || clis.includes(c.mode));

  const pickChip = (mode: LaunchMode, project: Project): void => {
    const chip = LAUNCH_CHIPS.find((c) => c.mode === mode)!;
    if (!chip.needsPrompt) {
      onLaunch(mode, project);
      return;
    }
    setFormMode(mode);
    setPrompt("");
  };

  const confirmForm = (): void => {
    if (!selectedProject || !formMode) return;
    onLaunch(formMode, selectedProject, prompt);
    setFormMode(undefined);
  };

  const startAdd = (): void => {
    setSaveError(undefined);
    setEditing({ original: undefined, form: { ...EMPTY_FORM } });
  };

  const startEdit = (p: Project): void => {
    setSaveError(undefined);
    setEditing({ original: p.path, form: { name: p.name, path: p.path } });
  };

  const cancelEdit = (): void => { setEditing(undefined); setSaveError(undefined); };

  const browsePath = async (): Promise<void> => {
    const dir = await window.bean.pickProjectFolder();
    if (!dir || !editing) return;
    const name = editing.form.name || dir.split("/").filter(Boolean).pop() || dir;
    setEditing({ ...editing, form: { ...editing.form, path: dir, name } });
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    const name = editing.form.name.trim();
    const path = editing.form.path.trim();
    if (!name || !path) {
      setSaveError("Name and path are required");
      return;
    }
    const others = projects.filter((p) => p.path !== editing.original);
    if (others.some((p) => p.path === path)) {
      setSaveError(`A project with path "${path}" already exists`);
      return;
    }
    // Preserve skill-group assignments across an edit — they're not part of the edit form.
    const priorSkills = projects.find((p) => p.path === editing.original)?.skills;
    const edited: Project = { name, path, ...(priorSkills ? { skills: priorSkills } : {}) };
    // Edit in place: re-appending would jump the project (and its Notes group) to the bottom.
    const at = projects.findIndex((p) => p.path === editing.original);
    const next = at < 0 ? [...others, edited] : projects.map((p, i) => (i === at ? edited : p));
    try {
      await window.bean.saveProjects(next);
      setEditing(undefined);
      setSaveError(undefined);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeProject = async (p: Project): Promise<void> => {
    if (!confirm(`Remove project "${p.name}"?`)) return;
    await window.bean.saveProjects(projects.filter((x) => x.path !== p.path));
    if (selected === p.path) setSelected(undefined);
    await refresh();
  };

  return (
    <div class="bean-projects-grid">
      <div class="bean-projects-list">
        {projects.length === 0 ? (
          <div class="bean-panel-empty">No projects yet — add one below.</div>
        ) : (
          projectsByName(projects).map((p) => (
            <div
              key={p.path}
              class={`bean-projects-row${selected === p.path ? " bean-projects-row--selected" : ""}`}
              onClick={() => { setSaveError(undefined); setSelected(p.path === selected ? undefined : p.path); }}
            >
              <span class="bean-projects-name">{p.name}</span>
              <span class="bean-projects-path" title={p.path}>{truncateMiddle(p.path)}</span>
              <span class="bean-projects-meta">
                {countOf(p.skills?.length ?? 0, "skill")}
                {sprouts ? ` · ${countOf(sprouts.get(p.path)?.length ?? 0, "sprout")}` : ""}
              </span>
              <span class="bean-projects-row-actions">
                <button
                  type="button"
                  class="bean-btn bean-btn--ghost"
                  onClick={(e) => { e.stopPropagation(); startEdit(p); }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="bean-btn bean-btn--ghost"
                  onClick={(e) => { e.stopPropagation(); void removeProject(p); }}
                >
                  Remove
                </button>
              </span>
            </div>
          ))
        )}
        <button type="button" class="bean-btn" onClick={startAdd}>+ Add project</button>
      </div>
      <div class="bean-projects-launch">
        {editing ? (
          <div class="bean-launch-form">
            <div class="bean-launch-label">{editing.original ? "EDIT PROJECT" : "ADD PROJECT"}</div>
            <label class="bean-field">
              <span class="bean-field-label">NAME</span>
              <input
                class="bean-input bean-input--boxed"
                type="text"
                value={editing.form.name}
                placeholder="acme"
                onInput={(e) => setEditing({ ...editing, form: { ...editing.form, name: (e.target as HTMLInputElement).value } })}
              />
            </label>
            <label class="bean-field">
              <span class="bean-field-label">PATH</span>
              <div class="bean-browse-row">
                <input
                  class="bean-input bean-input--boxed"
                  type="text"
                  value={editing.form.path}
                  placeholder={pickFolder ? "/path/to/project" : `/path/on/${caps.host ?? "the core"}`}
                  onInput={(e) => setEditing({ ...editing, form: { ...editing.form, path: (e.target as HTMLInputElement).value } })}
                />
                {pickFolder ? <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browsePath()}>Browse…</button> : null}
              </div>
            </label>
            {saveError ? <div class="bean-skills-error">{saveError}</div> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void saveEdit()}>Save</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        ) : selectedProject ? (
          <div>
            {handoff ? <div class="bean-launch-label">LAUNCH</div> : null}
            <div class="bean-launch-chips">
              {(handoff ? chips : []).map((c) => (
                <button
                  key={c.mode}
                  type="button"
                  class="bean-launch-chip"
                  onClick={() => pickChip(c.mode, selectedProject)}
                >
                  {c.label}
                </button>
              ))}
              {pickFolder ? (
                <button
                  type="button"
                  class="bean-launch-chip"
                  onClick={() => window.bean.revealInFinder(selectedProject.path)}
                >
                  Reveal in Finder
                </button>
              ) : (
                <button
                  type="button"
                  class="bean-launch-chip"
                  onClick={() => { copyPath(selectedProject.path).then(() => setCopied(true), () => {}); }}
                  onBlur={() => setCopied(false)}
                >
                  {copied ? "Copied" : "Copy path"}
                </button>
              )}
            </div>
            {formMode ? (
              <div class="bean-launch-form">
                <textarea
                  class="bean-card-prompt"
                  value={prompt}
                  placeholder="What should it do?"
                  onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
                />
                <div class="bean-card-actions">
                  <button type="button" class="bean-btn" onClick={confirmForm}>Launch</button>
                  <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setFormMode(undefined)}>Cancel</button>
                </div>
              </div>
            ) : null}
            <div class="bean-launch-label">SKILLS</div>
            <div class="bean-launch-chips bean-projects-members">
              {(selectedProject.skills ?? []).map((name) => (
                <span key={name} class="bean-projects-member">
                  {name}
                  <button
                    type="button"
                    class="bean-projects-member-remove"
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name} from ${selectedProject.name}`}
                    onClick={() => void setProjectSkill(selectedProject.path, name, false)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <select
                class="bean-input bean-projects-add-skill"
                value=""
                onChange={(e) => {
                  const name = (e.target as HTMLSelectElement).value;
                  (e.target as HTMLSelectElement).value = "";
                  if (name) void setProjectSkill(selectedProject.path, name, true);
                }}
              >
                <option value="">+ Add skill…</option>
                {skills
                  .filter((s) => s.enabled !== false && !selectedProject.skills?.includes(s.name))
                  .map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </div>
            {saveError ? <div class="bean-skills-error">{saveError}</div> : null}
            {sprouts ? (
              <>
                <div class="bean-launch-label">SPROUTS</div>
                <div class="bean-launch-chips bean-projects-members">
                  {(sprouts.get(selectedProject.path) ?? []).map((name) => (
                    <span key={name} class="bean-projects-member">{name}</span>
                  ))}
                  {(sprouts.get(selectedProject.path)?.length ?? 0) === 0 ? <span class="bean-projects-none">None</span> : null}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <PanelEmptyState message="Select a project to launch it, or add a new one." />
        )}
      </div>
    </div>
  );
}
