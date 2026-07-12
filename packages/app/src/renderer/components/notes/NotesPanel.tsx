import { useEffect, useMemo, useState } from "preact/hooks";
import { Markdown } from "../../shared/Markdown.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import type { Note, Project } from "@bean/core";

type Mode = "view" | "edit" | "add";

// Reuses the Skills panel anatomy (and its bean-skills-* styles): list left, detail right.
export function NotesPanel() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [query, setQuery] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const [nextNotes, nextProjects] = await Promise.all([
      window.bean.listNotes(),
      window.bean.listProjects(),
    ]);
    setNotes(nextNotes);
    setProjects(nextProjects);
    setSelectedSlug((prev) => (prev && nextNotes.some((n) => n.slug === prev) ? prev : undefined));
  };

  useEffect(() => { void refresh(); }, []);

  const selected = notes.find((n) => n.slug === selectedSlug);
  const projectName = (path?: string): string | undefined =>
    path ? (projects.find((p) => p.path === path)?.name ?? path) : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)) : notes;
  }, [notes, query]);

  // Group by project (registry order), General last; notes stay updated-first within a group.
  const groups = useMemo(() => {
    const out: { label: string; notes: Note[] }[] = [];
    for (const p of projects) {
      const own = filtered.filter((n) => n.project === p.path);
      if (own.length > 0) out.push({ label: p.name, notes: own });
    }
    const general = filtered.filter((n) => !n.project || !projects.some((p) => p.path === n.project));
    if (general.length > 0) out.push({ label: "General", notes: general });
    return out;
  }, [filtered, projects]);

  const snippet = (body: string): string => {
    const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("#")) ?? "";
    return line.length > 90 ? `${line.slice(0, 90)}…` : line;
  };

  const metaLine = (n: Note): string => {
    const day = n.updated ? new Date(n.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    return [day, `v${n.version}`, n.source === "chat" ? "from chat" : "yours"].filter(Boolean).join(" · ");
  };

  const select = (slug: string): void => { setSelectedSlug(slug); setMode("view"); setSaveError(undefined); };

  const startEdit = (): void => {
    if (!selected) return;
    setDraftTitle(selected.title);
    setDraftBody(selected.body);
    setSaveError(undefined);
    setMode("edit");
  };

  const startAdd = (): void => {
    setDraftTitle("");
    setDraftBody("");
    setSaveError(undefined);
    setMode("add");
  };

  const save = async (): Promise<void> => {
    try {
      const slug = await window.bean.saveNote(
        mode === "edit" && selected
          ? { title: draftTitle, body: draftBody, project: selected.project, slug: selected.slug, source: selected.source }
          : { title: draftTitle, body: draftBody, source: "manual" },
      );
      await refresh();
      setSelectedSlug(slug);
      setMode("view");
      setSaveError(undefined);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!confirm(`Delete note "${selected.title}"? Past versions stay in .history.`)) return;
    try {
      await window.bean.deleteNote(selected.slug);
      setSelectedSlug(undefined);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const setProject = async (path: string | undefined): Promise<void> => {
    if (!selected) return;
    try {
      await window.bean.saveNote({
        title: selected.title, body: selected.body, project: path, slug: selected.slug, source: selected.source,
      });
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const continueInChat = (): void => {
    if (!selected) return;
    window.bean.runInChat(
      `Let's pick up where we left off on "${selected.title}".`,
      `Continue: ${selected.title}`,
      selected.slug,
    );
  };

  const noteRow = (n: Note) => (
    <div
      key={n.slug}
      class={`bean-skills-row${selectedSlug === n.slug ? " bean-skills-row--selected" : ""}`}
      onClick={() => select(n.slug)}
    >
      <div class="bean-skills-row-main">
        <div class="bean-notes-row-title">
          <span class="bean-notes-row-text">{n.title}</span>
          {n.openCount > 0 ? <span class="bean-notes-open">{n.openCount} OPEN</span> : null}
        </div>
        <div class="bean-notes-snippet">{snippet(n.body) || "(empty)"}</div>
        <div class="bean-notes-meta">{metaLine(n)}</div>
      </div>
    </div>
  );

  const editor = (
    <>
      <input
        class="bean-input bean-input--boxed bean-notes-title"
        type="text"
        placeholder="Note title"
        value={draftTitle}
        onInput={(e) => setDraftTitle((e.target as HTMLInputElement).value)}
      />
      <textarea
        class="bean-skills-editor"
        placeholder={"## Summary\n\n## Key ideas\n\n## Open questions\n- [ ] …"}
        value={draftBody}
        onInput={(e) => setDraftBody((e.target as HTMLTextAreaElement).value)}
      />
      {saveError ? <div class="bean-status bean-status--error">{saveError}</div> : null}
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" onClick={() => void save()}>Save</button>
        <button type="button" class="bean-btn bean-btn--ghost" onClick={() => { setMode("view"); setSaveError(undefined); }}>Cancel</button>
      </div>
    </>
  );

  return (
    <div class="bean-skills">
      <div class="bean-skills-list">
        <div class="bean-skills-search">
          <input
            type="text"
            class="bean-skills-search-input"
            placeholder="Search notes"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="bean-skills-list-label">All notes · {notes.length}</div>
        {notes.length === 0 ? (
          <div class="bean-panel-empty">No notes yet — save a talk from chat, or add one below.</div>
        ) : filtered.length === 0 ? (
          <div class="bean-panel-empty">No notes match "{query}".</div>
        ) : (
          groups.map((g) => (
            <div key={g.label} class="bean-skills-row-group">
              <div class="bean-skills-list-label">{g.label} · {g.notes.length}</div>
              {g.notes.map(noteRow)}
            </div>
          ))
        )}
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-btn" onClick={startAdd}>+ New note</button>
        <div class="bean-skills-path">~/.bean/notes/*.md — plain markdown, yours to edit</div>
      </div>
      <div class="bean-skills-detail">
        {mode === "add" ? editor : null}
        {mode === "edit" && selected ? editor : null}
        {mode === "view" && selected ? (
          <>
            <div class="bean-skills-header">
              <div class="bean-skills-header-main">
                <div class="bean-skills-title-row">
                  <div class="bean-skills-title">{selected.title}</div>
                  {selected.project ? <span class="bean-skills-tag">{projectName(selected.project)}</span> : null}
                </div>
                <div class="bean-skills-description">
                  {selected.source === "chat" ? "Saved from chat" : "Written by you"} · v{selected.version} · {metaLine(selected)}
                </div>
              </div>
              <button type="button" class="bean-btn" onClick={continueInChat}>💬 Continue in chat</button>
            </div>

            <div class="bean-skills-projects">
              <div class="bean-field-label">PROJECT</div>
              {projects.length === 0 ? (
                <div class="bean-skills-description">No projects configured.</div>
              ) : (
                <div class="bean-skills-project-chips">
                  {projects.map((p) => {
                    const on = selected.project === p.path;
                    return (
                      <button
                        key={p.path}
                        type="button"
                        class={`bean-skills-project-chip${on ? " bean-skills-project-chip--on" : ""}`}
                        onClick={() => void setProject(on ? undefined : p.path)}
                      >
                        {on ? "✓ " : ""}{p.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div class="bean-skills-preview-box bean-notes-body">
              <Markdown text={selected.body} />
            </div>

            {saveError ? <div class="bean-status bean-status--error">{saveError}</div> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn bean-btn--ghost" onClick={startEdit}>Edit note</button>
              <span class="bean-skills-spacer" />
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void remove()}>Delete…</button>
            </div>
          </>
        ) : null}
        {mode === "view" && !selected ? (
          <PanelEmptyState message="Select a note to view it, or add a new one." />
        ) : null}
      </div>
    </div>
  );
}
