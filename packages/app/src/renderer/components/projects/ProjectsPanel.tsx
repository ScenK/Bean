import { useEffect, useState } from "preact/hooks";
import type { Project, LaunchMode, Skill } from "@bean/core";
import { truncateMiddle } from "./truncate-path.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";

const LAUNCH_CHIPS: { mode: LaunchMode; label: string; needsPrompt: boolean }[] = [
  { mode: "opencode", label: "opencode", needsPrompt: true },
  { mode: "claude", label: "claude", needsPrompt: true },
  { mode: "codex", label: "codex", needsPrompt: true },
  { mode: "open", label: "Open in Editor", needsPrompt: false },
];

type FormState = { name: string; path: string; defaultSkill: string };
const EMPTY_FORM: FormState = { name: "", path: "", defaultSkill: "" };


export function ProjectsPanel({
  onLaunch,
}: {
  onLaunch: (mode: LaunchMode, project: Project, prompt?: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [clis, setClis] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [formMode, setFormMode] = useState<LaunchMode | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  // `original` tracks the path being edited (undefined = adding a new project) so save
  // can replace the right entry even if the user changes the path in the form.
  const [editing, setEditing] = useState<{ original: string | undefined; form: FormState } | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const [nextProjects, nextSkills] = await Promise.all([
      window.bean.listProjects(),
      window.bean.listSkills(),
    ]);
    setProjects(nextProjects);
    setSkills(nextSkills);
  };

  useEffect(() => {
    void refresh();
    void window.bean.availableClis().then(setClis);
  }, []);

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
    setEditing({ original: p.path, form: { name: p.name, path: p.path, defaultSkill: p.defaultSkill ?? "" } });
  };

  const cancelEdit = (): void => setEditing(undefined);

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
    const next = [
      ...others,
      {
        name, path,
        ...(editing.form.defaultSkill ? { defaultSkill: editing.form.defaultSkill } : {}),
        ...(priorSkills ? { skills: priorSkills } : {}),
      },
    ];
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
          projects.map((p) => (
            <div
              key={p.path}
              class={`bean-projects-row${selected === p.path ? " bean-projects-row--selected" : ""}`}
              onClick={() => setSelected(p.path === selected ? undefined : p.path)}
            >
              <span class="bean-projects-name">{p.name}</span>
              <span class="bean-projects-path" title={p.path}>{truncateMiddle(p.path)}</span>
              {p.defaultSkill ? <span class="bean-chip">{p.defaultSkill}</span> : null}
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
                  placeholder="/path/to/project"
                  onInput={(e) => setEditing({ ...editing, form: { ...editing.form, path: (e.target as HTMLInputElement).value } })}
                />
                <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browsePath()}>Browse…</button>
              </div>
            </label>
            <label class="bean-field">
              <span class="bean-field-label">DEFAULT SKILL</span>
              <select
                class="bean-input bean-input--boxed"
                value={editing.form.defaultSkill}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, defaultSkill: (e.target as HTMLSelectElement).value } })}
              >
                <option value="">None</option>
                {skills.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
            {saveError ? <div class="bean-skills-error">{saveError}</div> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void saveEdit()}>Save</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        ) : selectedProject ? (
          <div>
            <div class="bean-launch-label">LAUNCH</div>
            <div class="bean-launch-chips">
              {chips.map((c) => (
                <button
                  key={c.mode}
                  type="button"
                  class="bean-launch-chip"
                  onClick={() => pickChip(c.mode, selectedProject)}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                class="bean-launch-chip"
                onClick={() => window.bean.revealInFinder(selectedProject.path)}
              >
                Reveal in Finder
              </button>
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
          </div>
        ) : (
          <PanelEmptyState message="Select a project to launch it, or add a new one." />
        )}
      </div>
    </div>
  );
}
