import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Project, RouteSuggestion, Skill } from "@bean/core";
import { parseFrontmatter, setFrontmatter } from "@bean/core/frontmatter";
import { bestProjectForSkill } from "@bean/core/project-select";
import { composePrompt } from "@bean/core/prompt";
import { skillSection, type SkillSection } from "@bean/core/usage-sections";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import { ListFoldToggle, useListFold } from "../../shared/ListFold.js";
import { ProposalsInbox, type ProposalLists } from "./ProposalsInbox.js";

/** The Run button's Plan-card seed. No linked project → projectPath omitted, so the card opens
 * on "no project" (scratch). Same composePrompt() the drag-drop-onto-petal flow uses, so both
 * paths hand the agent an identically-shaped prompt (skill body, "## Task" only with guidance). */
export function runForSkill(skill: Skill, projects: Project[]): RouteSuggestion {
  const projectPath = bestProjectForSkill(skill.name, projects)?.path;
  return { skillName: skill.name, ...(projectPath ? { projectPath } : {}), composedPrompt: composePrompt(skill, ""), confidence: 1 };
}

type Mode = "view" | "edit" | "add" | "proposals";

const SECTION_LABELS: Record<SkillSection, string> = { skills: "Skills", "sprout-steps": "Sprout steps", disabled: "Disabled" };
const SECTION_ORDER: SkillSection[] = ["skills", "sprout-steps", "disabled"];

/** Sections need every skill's `usedBy`; absent (older core, unreadable sprouts) means unknown,
 * and filing by a guess would misplace sprout-only skills — so the list stays flat. */
export const hasUsage = (skills: Skill[]): boolean => skills.every((s) => s.usedBy !== undefined);

/** The list's sections, in order, empty ones dropped. Not `sectioned`: the flat list — enabled
 * skills (rendered under no header), then Disabled. */
export function skillGroups(skills: Skill[], projects: Project[], sectioned: boolean): { key: SkillSection; skills: Skill[] }[] {
  const sectionOf = (s: Skill): SkillSection =>
    sectioned ? skillSection(s, projects) : s.enabled === false ? "disabled" : "skills";
  return SECTION_ORDER
    .map((key) => ({ key, skills: skills.filter((s) => sectionOf(s) === key) }))
    .filter((g) => g.skills.length > 0);
}

export type SkillChip = { label: string; kind: "tag" | "general" | "warn" };

/** Where a row's skill is reachable: `avatar`, its projects, `↻ <sprout>` per sprout — or
 * `chat & bots` when none apply. A disabled skill an enabled sprout still uses says that step
 * fails; an off sprout (`usedByOff`) gets a neutral `fails if run` chip instead. */
export function skillChips(skill: Skill, projects: Project[]): SkillChip[] {
  const off = skill.enabled === false;
  const sprouts = skill.usedBy ?? [];
  const chips: SkillChip[] = [
    ...(!off && skill.quickLaunch !== false ? [{ label: "avatar", kind: "tag" as const }] : []),
    ...projects.filter((p) => p.skills?.includes(skill.name)).map((p) => ({ label: p.name, kind: "tag" as const })),
  ];
  if (off) {
    // Only an enabled sprout's step fails on its own; an off one fails only if run by hand.
    const offSprouts = new Set(skill.usedByOff ?? []);
    const on = sprouts.filter((n) => !offSprouts.has(n));
    if (on.length > 0) {
      chips.push({ label: `used by ${on.join(", ")} — ${on.length === 1 ? "its step fails" : "their steps fail"}`, kind: "warn" });
    }
    chips.push(...sprouts.filter((n) => offSprouts.has(n)).map((n) => ({ label: `↻ ${n} (off) — fails if run`, kind: "general" as const })));
    return chips;
  }
  chips.push(...sprouts.map((n) => ({ label: `↻ ${n}`, kind: "tag" as const })));
  return chips.length > 0 ? chips : [{ label: "chat & bots", kind: "general" }];
}

// Which sections are open, by key. A view preference, so the renderer's own localStorage
// (pattern: NotesPanel); absent or unreadable = the default, Skills open and the rest folded.
const OPEN_SECTIONS_KEY = "bean.skills.openSections";
function loadOpenSections(): SkillSection[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) return raw.filter((v): v is SkillSection => SECTION_ORDER.includes(v as SkillSection));
  } catch { /* fall through to the default */ }
  return ["skills"];
}

export function SkillsPanel({
  onRunSkill = () => {},
}: {
  onRunSkill?: (run: RouteSuggestion) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [listFolded, toggleListFold] = useListFold("bean.skills.listFolded");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedName, setSelectedName] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [draftName, setDraftName] = useState("");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [openSections, setOpenSections] = useState<SkillSection[]>(loadOpenSections);
  const [proposals, setProposals] = useState<ProposalLists>({ pending: [], applied: [] });

  const refresh = async (): Promise<void> => {
    const [nextSkills, nextProjects, nextProposals] = await Promise.all([
      window.bean.listSkills(),
      window.bean.listProjects(),
      // A remote core has no proposals op (it rejects) — the list still loads, the inbox stays hidden.
      window.bean.skillProposalsList().catch((): ProposalLists => ({ pending: [], applied: [] })),
    ]);
    setSkills(nextSkills);
    setProjects(nextProjects);
    setProposals(nextProposals);
    setSelectedName((prev) => (prev && nextSkills.some((s) => s.name === prev) ? prev : undefined));
  };

  useEffect(() => {
    void refresh();
    // A retro routine can draft proposals while the window sits open; catch up on focus.
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const selectedSkill = skills.find((s) => s.name === selectedName);
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? skills.filter((s) => s.name.toLowerCase().includes(q)) : skills;
  }, [skills, query]);
  const sectioned = hasUsage(skills);
  const groups = useMemo(() => skillGroups(filteredSkills, projects, sectioned), [filteredSkills, projects, sectioned]);

  const setSectionOpen = (key: SkillSection, open: boolean): void => {
    setOpenSections((prev) => {
      if (prev.includes(key) === open) return prev;
      const next = open ? [...prev, key] : prev.filter((k) => k !== key);
      try { localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(next)); } catch { /* private mode / quota: fold still works this session */ }
      return next;
    });
  };

  // A toggle (enable, quick-launch, project) can move the selected skill to another section:
  // open that section if it is folded and keep the row in view, so it never vanishes from under
  // the click. Keyed on the skill name, so only a change of section — not of selection — acts.
  const lastSection = useRef<{ name: string; key: SkillSection } | undefined>(undefined);
  useEffect(() => {
    const key = selectedName ? groups.find((g) => g.skills.some((s) => s.name === selectedName))?.key : undefined;
    const prev = lastSection.current;
    lastSection.current = selectedName && key ? { name: selectedName, key } : undefined;
    if (!key || !prev || prev.name !== selectedName || prev.key === key) return;
    setSectionOpen(key, true);
    requestAnimationFrame(() => document.querySelector(".bean-skills-list .bean-skills-row--selected")?.scrollIntoView({ block: "nearest" }));
  }, [groups, selectedName]);

  const skillRow = (s: Skill) => {
    return (
      <div
        key={s.name}
        class={`bean-skills-row${selectedName === s.name ? " bean-skills-row--selected" : ""}${s.enabled === false ? " bean-skills-row--off" : ""}`}
        onClick={() => selectSkill(s.name)}
      >
        {/* Enable/disable pill — the everywhere switch; orange = on, gray = off. */}
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled !== false}
          class={`bean-skills-pill${s.enabled !== false ? " bean-skills-pill--on" : ""}`}
          title={s.enabled === false ? "Disabled everywhere — click to enable" : "Enabled — click to disable everywhere"}
          onClick={(e) => { e.stopPropagation(); void setFlag(s, "enabled", s.enabled === false); }}
        >
          <span class="bean-skills-pill-knob" />
        </button>
        <div class="bean-skills-row-main">
          <div class="bean-skills-row-name">{s.name}</div>
          <div class="bean-skills-row-chips">
            {skillChips(s, projects).map((c) => (
              <span key={c.label} class={`bean-skills-tag${c.kind === "tag" ? "" : ` bean-skills-tag--${c.kind}`}`}>{c.label}</span>
            ))}
            {s.browser ? <span class="bean-skills-tag">🌐 uses your browser</span> : null}
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
    const targetProblem = targetHintFor(draft);
    if (targetProblem) { setSaveError(targetProblem); return; }
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
    const targetProblem = targetHintFor(draft);
    if (targetProblem) { setSaveError(targetProblem); return; }
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
    const confirmMsg = selectedSkill.overridesBuiltIn
      ? `Reset "${selectedSkill.name}" to its built-in version? Your edits will be lost.`
      : `Delete skill "${selectedSkill.name}"? This cannot be undone.`;
    if (!confirm(confirmMsg)) return;
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

  // Persist either toggle by rewriting the skill's frontmatter. Clears the key when on (the
  // default) to keep files clean; writes `<key>: false` only when switched off.
  const setFlag = async (skill: Skill, key: "enabled" | "quick-launch", on: boolean): Promise<void> => {
    try {
      await window.bean.saveSkill(skill.name, setFrontmatter(skill.body, key, on ? undefined : "false"));
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  // Save-time check for `target:` — Bean's own required tag deciding whether a confirmed run
  // goes to the terminal (opencode) or back into the chat window. Never auto-inserted: where
  // a skill runs is the user's call, so saving is blocked until they pick one.
  const targetHintFor = (body: string): string | undefined => {
    const target = parseFrontmatter(body).target?.toLowerCase();
    if (target === "chat" || target === "terminal") return undefined;
    if (target) return `Unknown target "${target}" — use \`target: terminal\` (run in coding agent) or \`target: chat\` (reply in Bean's chat).`;
    return "Add `target: terminal` (run in opencode) or `target: chat` (reply in Bean's chat) to the frontmatter — Bean needs it to route the skill.";
  };

  // A disabled skill is off everywhere, and "everywhere" includes this panel's own Run button.
  const canRun = selectedSkill?.enabled !== false;

  const runSkill = (): void => {
    if (!selectedSkill || selectedSkill.enabled === false) return;
    onRunSkill(runForSkill(selectedSkill, projects));
  };

  return (
    <div class={listFolded ? "bean-skills bean-skills--folded" : "bean-skills"}>
      <ListFoldToggle folded={listFolded} onToggle={toggleListFold} listId="bean-skills-list" />
      <div class="bean-skills-list" id="bean-skills-list">
        <div class="bean-skills-search">
          <input
            type="text"
            class="bean-skills-search-input"
            placeholder="Search skills"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        {proposals.pending.length > 0 || proposals.applied.length > 0 ? (
          <button
            type="button"
            class={`bean-skills-row bean-skills-proposals-tab${mode === "proposals" ? " bean-skills-row--selected" : ""}`}
            onClick={() => { setSelectedName(undefined); setMode("proposals"); }}
          >
            <span class="bean-skills-row-name">Proposals</span>
            {proposals.pending.length > 0 ? <span class="bean-skills-badge bean-skills-badge--yours">{proposals.pending.length}</span> : null}
          </button>
        ) : null}
        <div class="bean-skills-list-label">All skills · {skills.length}</div>
        {skills.length === 0 ? (
          <div class="bean-panel-empty">No skills yet — add one below.</div>
        ) : filteredSkills.length === 0 ? (
          <div class="bean-panel-empty">No skills match "{query}".</div>
        ) : (
          groups.map((g) => {
            // The flat fallback lists enabled skills under no header, as before sections.
            if (!sectioned && g.key === "skills") return <div key={g.key}>{g.skills.map(skillRow)}</div>;
            // A live query opens every section with a hit (empty ones are already gone) and
            // locks folding meanwhile; the stored state returns when the query clears.
            const searching = query.trim() !== "";
            const open = searching || openSections.includes(g.key);
            return (
              <div key={g.key} class="bean-skills-section" data-section={g.key}>
                <button
                  type="button"
                  class="bean-skills-list-label bean-skills-list-label--toggle bean-notes-group"
                  aria-expanded={open}
                  disabled={searching}
                  title={searching ? "Clear the search to fold sections" : undefined}
                  onClick={() => setSectionOpen(g.key, !open)}
                >
                  <span class="bean-notes-group-caret">{open ? "\u25be" : "\u25b8"}</span>
                  {SECTION_LABELS[g.key]}
                  <span class="bean-notes-group-count">{g.skills.length}</span>
                </button>
                {open ? g.skills.map(skillRow) : null}
              </div>
            );
          })
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
                <div class="bean-skills-toggle-pair">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={selectedSkill.enabled !== false}
                    class={`bean-skills-toggle${selectedSkill.enabled !== false ? " bean-skills-toggle--on" : ""}`}
                    title="Off switches the skill off everywhere — chat, chatops, sprouts and quick-launch"
                    onClick={() => void setFlag(selectedSkill, "enabled", selectedSkill.enabled === false)}
                  >
                    <span class="bean-skills-toggle-knob" />
                  </button>
                  <span class="bean-skills-toggle-label">
                    {selectedSkill.enabled !== false ? "Enabled everywhere" : "Disabled everywhere"}
                  </span>
                </div>
                {/* Quick-launch is a subset of enabled, so it reads as off (and stays untouchable)
                    while the skill is disabled — no pretending a petal will show. */}
                <div class="bean-skills-toggle-pair">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={selectedSkill.enabled !== false && selectedSkill.quickLaunch !== false}
                    disabled={selectedSkill.enabled === false}
                    class={`bean-skills-toggle${selectedSkill.enabled !== false && selectedSkill.quickLaunch !== false ? " bean-skills-toggle--on" : ""}`}
                    title="Off hides the skill from the drag-onto-avatar petals; chat and chatops still use it"
                    onClick={() => void setFlag(selectedSkill, "quick-launch", selectedSkill.quickLaunch === false)}
                  >
                    <span class="bean-skills-toggle-knob" />
                  </button>
                  <span class="bean-skills-toggle-label">
                    {selectedSkill.enabled === false
                      ? "Quick-launch off while disabled"
                      : selectedSkill.quickLaunch !== false ? "In quick-launch" : "Hidden from quick-launch"}
                  </span>
                </div>
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
                    Tap to assign. Clear all chips to make this a general skill — it runs in a scratch workspace unless you pick a project.
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
                title={selectedSkill.enabled === false ? "Skill is disabled — switch it on to run it" : undefined}
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
                title={selectedSkill.source === "project" ? "Built-in skill — edit it to make your own copy, then you can delete that copy" : selectedSkill.overridesBuiltIn ? "Discard your edits and go back to the built-in version" : undefined}
                onClick={() => void deleteSkill()}
              >
                {selectedSkill.overridesBuiltIn ? "Reset…" : "Delete…"}
              </button>
            </div>
          </>
        ) : null}
        {selectedSkill && mode === "edit" ? (
          <>
            <textarea
              class="bean-skills-editor"
              value={draft}
              onInput={(e) => { setDraft((e.target as HTMLTextAreaElement).value); setSaveError(undefined); }}
            />
            {saveError ? <div class="bean-skills-notice">{saveError}</div> : null}
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
              placeholder={"---\ndescription: One line for Bean\ntarget: terminal\n---\n# Skill title\nSteps..."}
              onInput={(e) => { setDraft((e.target as HTMLTextAreaElement).value); setSaveError(undefined); }}
            />
            {saveError ? <div class="bean-skills-notice">{saveError}</div> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void saveNew()}>Save</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelAdd}>Cancel</button>
            </div>
          </>
        ) : null}
        {mode === "proposals" ? <ProposalsInbox proposals={proposals} onChanged={refresh} /> : null}
        {!selectedSkill && mode !== "add" && mode !== "proposals" ? (
          <PanelEmptyState message="Select a skill to view it, or add a new one." />
        ) : null}
      </div>
    </div>
  );
}
