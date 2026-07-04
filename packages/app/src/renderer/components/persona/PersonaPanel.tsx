import { useEffect, useState } from "preact/hooks";
import { PERSONA_TAGS, type Persona, type PersonaTag } from "@bean/core/persona";
import type { Memory, Project } from "@bean/core";

const SAMPLE_VOICE = "“Done — left two notes on the retry loop. Want me to open the PR?”";

type Mode = "view" | "edit";

export function PersonaPanel() {
  const [persona, setPersona] = useState<Persona | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [draftName, setDraftName] = useState("");
  const [draftTags, setDraftTags] = useState<PersonaTag[]>([]);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memError, setMemError] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const [p, mem, projs] = await Promise.all([
      window.bean.getPersona(),
      window.bean.listMemories(),
      window.bean.listProjects(),
    ]);
    setPersona(p);
    setMemories(mem);
    setProjects(projs);
  };

  useEffect(() => { void refresh(); }, []);

  const startEdit = (): void => {
    if (!persona) return;
    setDraftName(persona.name);
    setDraftTags([...persona.tags]);
    setSaveError(undefined);
    setMode("edit");
  };

  const cancelEdit = (): void => {
    setMode("view");
    setSaveError(undefined);
  };

  const toggleTag = (tag: PersonaTag): void => {
    setDraftTags((prev) => {
      if (prev.includes(tag)) return prev.length > 1 ? prev.filter((t) => t !== tag) : prev;
      return [...prev, tag];
    });
  };

  const save = async (): Promise<void> => {
    try {
      await window.bean.savePersona({ name: draftName.trim(), tags: draftTags });
      await refresh();
      setMode("view");
      setSaveError(undefined);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const persist = async (next: Memory[]): Promise<void> => {
    setMemories(next);
    try { await window.bean.saveMemories(next); setMemError(undefined); }
    catch (err) { setMemError(err instanceof Error ? err.message : String(err)); }
  };
  const editMemory = (id: string, text: string): void =>
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
  const commitMemories = (): void => { void persist(memories); };
  const deleteMemory = (id: string): void => { void persist(memories.filter((m) => m.id !== id)); };
  const addMemory = (projectPath?: string): void => {
    const entry: Memory = { id: `${Date.now()}`, text: "", projectPath, createdAt: new Date().toISOString() };
    void persist([...memories, entry]);
  };

  if (!persona) {
    return (
      <div class="bean-panel-empty">Loading persona…</div>
    );
  }

  return (
    <div class="bean-persona">
      <div class="bean-persona-label">NAME</div>
      {mode === "view" ? (
        <div class="bean-persona-name">{persona.name}</div>
      ) : (
        <input
          class="bean-input bean-persona-name-input"
          value={draftName}
          onInput={(e) => setDraftName((e.target as HTMLInputElement).value)}
        />
      )}

      <div class="bean-persona-label">TONE</div>
      <div class="bean-persona-tags">
        {mode === "view"
          ? persona.tags.map((tag) => <span key={tag} class="bean-chip">{tag}</span>)
          : PERSONA_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                class={`bean-tag-chip${draftTags.includes(tag) ? " bean-tag-chip--selected" : ""}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
      </div>

      {mode === "view" ? (
        <>
          <div class="bean-persona-label">SAMPLE VOICE</div>
          <div class="bean-persona-sample">{SAMPLE_VOICE}</div>
        </>
      ) : null}

      {saveError ? <div class="bean-persona-error">Save failed: {saveError}</div> : null}

      <div class="bean-card-actions">
        {mode === "view" ? (
          <button type="button" class="bean-btn" onClick={startEdit}>Edit</button>
        ) : (
          <>
            <button type="button" class="bean-btn" onClick={() => void save()}>Save</button>
            <button type="button" class="bean-btn bean-btn--ghost" onClick={cancelEdit}>Cancel</button>
          </>
        )}
      </div>

      <div class="bean-persona-label">MEMORY</div>
      {memError ? <div class="bean-persona-error">Save failed: {memError}</div> : null}

      <div class="bean-memory-group-label">About you</div>
      {memories.filter((m) => !m.projectPath).length === 0 ? (
        <div class="bean-memory-empty">Nothing yet.</div>
      ) : (
        memories.filter((m) => !m.projectPath).map((m) => (
          <div key={m.id} class="bean-memory-item">
            <input
              class="bean-input bean-memory-input"
              value={m.text}
              onInput={(e) => editMemory(m.id, (e.target as HTMLInputElement).value)}
              onBlur={commitMemories}
            />
            <button type="button" class="bean-memory-del" onClick={() => deleteMemory(m.id)} aria-label="Delete">×</button>
          </div>
        ))
      )}
      <button type="button" class="bean-btn bean-btn--ghost" onClick={() => addMemory(undefined)}>+ Add about you</button>

      {projects.filter((p) => memories.some((m) => m.projectPath === p.path)).map((p) => (
        <div key={p.path}>
          <div class="bean-memory-group-label">{p.name}</div>
          {memories.filter((m) => m.projectPath === p.path).map((m) => (
            <div key={m.id} class="bean-memory-item">
              <input
                class="bean-input bean-memory-input"
                value={m.text}
                onInput={(e) => editMemory(m.id, (e.target as HTMLInputElement).value)}
                onBlur={commitMemories}
              />
              <button type="button" class="bean-memory-del" onClick={() => deleteMemory(m.id)} aria-label="Delete">×</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
