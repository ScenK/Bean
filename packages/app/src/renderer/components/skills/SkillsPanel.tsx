import { useEffect, useMemo, useState } from "preact/hooks";
import type { Project, RouteSuggestion, Skill } from "@bean/core";
import { setFrontmatter } from "@bean/core/frontmatter";
import { bestProjectForSkill } from "@bean/core/project-select";
import { composePrompt } from "@bean/core/prompt";

type Mode = "view" | "edit" | "add";

export function SkillsPanel({
  onRunSkill = () => {},
}: {
  onRunSkill?: (run: RouteSuggestion) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedName, setSelectedName] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [draftName, setDraftName] = useState("");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const [nextSkills, nextProjects] = await Promise.all([
      window.bean.listSkills(),
      window.bean.listProjects(),
    ]);
    setSkills(nextSkills);
    setProjects(nextProjects);
    setSelectedName((prev) => (prev && nextSkills.some((s) => s.name === prev) ? prev : nextSkills[0]?.name));
  };

  useEffect(() => { void refresh(); }, []);

  const selectedSkill = skills.find((s) => s.name === selectedName);
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? skills.filter((s) => s.name.toLowerCase().includes(q)) : skills;
    // Enabled first, disabled last; stable within each group.
    return [...matched].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false));
  }, [skills, query]);
  const firstDisabledName = filteredSkills.find((s) => s.enabled === false)?.name;
  const projectNamesFor = (name: string): string[] =>
    projects.filter((p) => p.skills?.includes(name)).map((p) => p.name);

  const skillRow = (s: Skill) => {
    const chips = projectNamesFor(s.name);
    return (
      <div
        key={s.name}
        class={`bean-skills-row${selectedName === s.name ? " bean-skills-row--selected" : ""}${s.enabled === false ? " bean-skills-row--off" : ""}`}
        onClick={() => selectSkill(s.name)}
      >
        {/* Enable/disable pill — orange = shown in the drag quick-launch, gray = hidden. */}
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled !== false}
          class={`bean-skills-pill${s.enabled !== false ? " bean-skills-pill--on" : ""}`}
          title={s.enabled === false ? "Hidden from quick-launch — click to enable" : "Shown in quick-launch — click to disable"}
          onClick={(e) => { e.stopPropagation(); void setEnabled(s, s.enabled === false); }}
        >
          <span class="bean-skills-pill-knob" />
        </button>
        <div class="bean-skills-row-main">
          <div class="bean-skills-row-name">{s.name}</div>
          <div class="bean-skills-row-chips">
            {chips.length > 0
              ? chips.map((n) => <span key={n} class="bean-skills-tag">{n}</span>)
              : <span class="bean-skills-tag bean-skills-tag--general">general — all projects</span>}
          </div>
        </div>
        <span class={`bean-skills-badge${s.source === "project" ? "" : " bean-skills-badge--yours"}`}>
          {s.source === "project" ? "BUILT-IN" : "YOURS"}
        </span>
      </div>
    );
  };

  const selectSkill = (name: string): void => {
    setSelectedName(name);
    setMode("view");
    setSaveError(undefined);
  };

  const startEdit = (): void => {
    if (!selectedSkill) return;
    setDraft(selectedSkill.body);
    setSaveError(undefined);
    setMode("edit");
  };

  const cancelEdit = (): void => {
    setMode("view");
    setSaveError(undefined);
  };

  const save = async (): Promise<void> => {
    if (!selectedSkill) return;
    try {
      await window.bean.saveSkill(selectedSkill.name, draft);
      await refresh();
      setMode("view");
      setSaveError(undefined);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const startAdd = (): void => {
    setDraftName("");
    setDraft("");
    setSaveError(undefined);
    setMode("add");
  };

  const cancelAdd = (): void => {
    setMode("view");
    setSaveError(undefined);
  };

  const saveNew = async (): Promise<void> => {
    const name = draftName.trim();
    if (!name) { setSaveError("Name is required"); return; }
    if (/[/\\]|\.\./.test(name)) { setSaveError("Name can't contain / \\ or .."); return; }
    if (skills.some((s) => s.name === name)) { setSaveError(`A skill named "${name}" already exists`); return; }
    try {
      await window.bean.saveSkill(name, draft);
      await refresh();
      setSelectedName(name);
      setMode("view");
      setSaveError(undefined);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteSkill = async (): Promise<void> => {
    if (!selectedSkill) return;
    if (!confirm(`Delete skill "${selectedSkill.name}"? This cannot be undone.`)) return;
    try {
      await window.bean.deleteSkill(selectedSkill.name);
      // Clean up any project↔skill assignments so nothing dangles.
      if (projects.some((p) => p.skills?.includes(selectedSkill.name))) {
        const cleaned = projects.map((p) =>
          p.skills?.includes(selectedSkill.name)
            ? { ...p, skills: p.skills.filter((n) => n !== selectedSkill.name) }
            : p,
        );
        await window.bean.saveProjects(cleaned);
      }
      setSelectedName(undefined);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleAssignment = async (project: Project, checked: boolean): Promise<void> => {
    if (!selectedSkill) return;
    const nextSkills = checked
      ? [...(project.skills ?? []), selectedSkill.name]
      : (project.skills ?? []).filter((n) => n !== selectedSkill.name);
    const nextProjects = projects.map((p) => (p.path === project.path ? { ...p, skills: nextSkills } : p));
    try {
      await window.bean.saveProjects(nextProjects);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  // Persist the enable toggle by rewriting the skill's frontmatter. Clears the key when true (the
  // default) to keep files clean; writes `enabled: false` only when disabled.
  const setEnabled = async (skill: Skill, enabled: boolean): Promise<void> => {
    try {
      await window.bean.saveSkill(skill.name, setFrontmatter(skill.body, "enabled", enabled ? undefined : "false"));
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const canRun = projects.length > 0;

  const runSkill = (): void => {
    if (!selectedSkill) return;
    const projectPath = bestProjectForSkill(selectedSkill.name, projects)?.path;
    if (!projectPath) return;
    // Same composePrompt() the drag-drop-onto-petal flow uses, so both paths hand opencode
    // an identically-shaped prompt (skill body first, "## Task" only when there's guidance).
    onRunSkill({ skillName: selectedSkill.name, projectPath, composedPrompt: composePrompt(selectedSkill, ""), confidence: 1 });
  };

  return (
    <div class="bean-skills">
      <div class="bean-skills-list">
        <div class="bean-skills-search">
          <input
            type="text"
            class="bean-skills-search-input"
            placeholder="Search skills"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="bean-skills-list-label">All skills · {skills.length}</div>
        {skills.length === 0 ? (
          <div class="bean-panel-empty">No skills yet — add one below.</div>
        ) : filteredSkills.length === 0 ? (
          <div class="bean-panel-empty">No skills match "{query}".</div>
        ) : (
          filteredSkills.map((s) => (
            <div key={s.name} class="bean-skills-row-group">
              {s.name === firstDisabledName ? <div class="bean-skills-list-label">Disabled</div> : null}
              {skillRow(s)}
            </div>
          ))
        )}
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-btn" onClick={startAdd}>+ Add skill</button>
        <div class="bean-skills-path">.bean/skills/*.md (built-in) + ~/.bean/skills/*.md (yours, wins)</div>
      </div>
      <div class="bean-skills-detail">
        {selectedSkill && mode === "view" ? (
          <>
            <div class="bean-skills-header">
              <div class="bean-skills-header-main">
                <div class="bean-skills-title-row">
                  <div class="bean-skills-title">{selectedSkill.name}</div>
                  <span class={`bean-skills-badge${selectedSkill.source === "project" ? "" : " bean-skills-badge--yours"}`}>
                    {selectedSkill.source === "project" ? "BUILT-IN" : "YOURS"}
                  </span>
                </div>
                <div class="bean-skills-description">{selectedSkill.description}</div>
              </div>
              <div class="bean-skills-toggle-col">
                <button
                  type="button"
                  role="switch"
                  aria-checked={selectedSkill.enabled !== false}
                  class={`bean-skills-toggle${selectedSkill.enabled !== false ? " bean-skills-toggle--on" : ""}`}
                  onClick={() => void setEnabled(selectedSkill, selectedSkill.enabled === false)}
                >
                  <span class="bean-skills-toggle-knob" />
                </button>
                <span class="bean-skills-toggle-label">
                  {selectedSkill.enabled !== false ? "Enabled everywhere" : "Hidden from quick-launch"}
                </span>
              </div>
            </div>

            <div class="bean-skills-projects">
              <div class="bean-field-label">PROJECTS</div>
              {projects.length === 0 ? (
                <div class="bean-skills-description">No projects configured.</div>
              ) : (
                <>
                  <div class="bean-skills-project-chips">
                    {projects.map((p) => {
                      const assigned = Boolean(p.skills?.includes(selectedSkill.name));
                      return (
                        <button
                          key={p.path}
                          type="button"
                          class={`bean-skills-project-chip${assigned ? " bean-skills-project-chip--on" : ""}`}
                          onClick={() => void toggleAssignment(p, !assigned)}
                        >
                          {assigned ? "✓ " : ""}{p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div class="bean-skills-projects-hint">
                    Tap to assign. Clear all chips to make this a general skill — available in every project.
                  </div>
                </>
              )}
            </div>

            <div class="bean-skills-preview-box">
              <div class="bean-skills-preview-header">
                <span>{selectedSkill.name}.md</span>
                <button type="button" class="bean-skills-preview-open" onClick={startEdit}>Open in editor ↗</button>
              </div>
              <div class="bean-skills-preview-body">{selectedSkill.body.split("\n").slice(0, 12).join("\n")}</div>
              <div class="bean-skills-preview-fade" />
            </div>

            {saveError ? <div class="bean-skills-error">{saveError}</div> : null}
            <div class="bean-card-actions">
              <button
                type="button"
                class="bean-btn"
                disabled={!canRun}
                title={!canRun ? "No projects configured" : undefined}
                onClick={runSkill}
              >
                Run skill
              </button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={startEdit}>
                Edit .md
              </button>
              <span class="bean-skills-spacer" />
              <button
                type="button"
                class="bean-skills-delete-link"
                disabled={selectedSkill.source === "project"}
                title={selectedSkill.source === "project" ? "Built-in skill — edit it to make your own copy, then you can delete that copy" : undefined}
                onClick={() => void deleteSkill()}
              >
                Delete…
              </button>
            </div>
          </>
        ) : null}
        {selectedSkill && mode === "edit" ? (
          <>
            <textarea
              class="bean-skills-editor"
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            />
            {saveError ? <div class="bean-skills-error">Save failed: {saveError}</div> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void save()}>Save</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelEdit}>Cancel</button>
            </div>
          </>
        ) : null}
        {mode === "add" ? (
          <>
            <div class="bean-launch-label">ADD SKILL</div>
            <label class="bean-field">
              <span class="bean-field-label">NAME</span>
              <input
                class="bean-input bean-input--boxed"
                type="text"
                value={draftName}
                placeholder="review-code"
                onInput={(e) => setDraftName((e.target as HTMLInputElement).value)}
              />
            </label>
            <textarea
              class="bean-skills-editor"
              value={draft}
              placeholder={"---\ndescription: One line for the router\n---\n# Skill title\nSteps..."}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            />
            {saveError ? <div class="bean-skills-error">{saveError}</div> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void saveNew()}>Save</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelAdd}>Cancel</button>
            </div>
          </>
        ) : null}
        {!selectedSkill && mode !== "add" ? (
          <div class="bean-panel-empty">Select a skill to view it, or add a new one.</div>
        ) : null}
      </div>
    </div>
  );
}
