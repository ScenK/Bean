import { useEffect, useRef, useState } from "preact/hooks";
import { PERSONA_TAGS, type Persona, type PersonaTag } from "@bean/core/persona";
import type { Memory, Project } from "@bean/core";
import type { MemoryBatch } from "../../../ipc.js";

const ago = (iso: string): string => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

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
  const [batch, setBatch] = useState<MemoryBatch | undefined>(undefined);
  const justRef = useRef<HTMLDivElement>(null);

  const refresh = async (): Promise<void> => {
    const [p, mem, projs, b] = await Promise.all([
      window.bean.getPersona(),
      window.bean.listMemories(),
      window.bean.listProjects(),
      window.bean.getMemoryBatch(),
    ]);
    setPersona(p);
    setMemories(mem);
    setProjects(projs);
    setBatch(b);
  };

  // The avatar's "Remembered N" bubble opens (or focuses) this window: refetch on focus so a
  // batch that landed while it was open shows up, then bring "Just remembered" into view.
  useEffect(() => {
    void refresh();
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => { if (batch) justRef.current?.scrollIntoView({ block: "nearest" }); }, [batch?.at]);

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

  // Every write is per-row (update/delete/append) — never a whole-list replace, which would
  // silently drop a fact auto-remember or a chatops bot saved while this panel was open.
  const run = async (op: () => Promise<unknown>): Promise<void> => {
    try { await op(); setMemError(undefined); }
    catch (err) { setMemError(err instanceof Error ? err.message : String(err)); }
  };
  const editMemory = (id: string, text: string): void =>
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
  const commitMemory = (m: Memory): void => { void run(() => window.bean.updateMemory(m.id, m.text)); };
  const deleteMemory = (id: string): void => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    void run(() => window.bean.deleteMemories([id]));
  };
  const addMemory = (projectPath?: string): void => {
    const entry: Memory = { id: crypto.randomUUID(), text: "", projectPath, createdAt: new Date().toISOString() };
    setMemories((prev) => [...prev, entry]);
    void run(() => window.bean.appendMemories([entry]));
  };
  const undoBatch = (): void => {
    void run(async () => { await window.bean.undoMemoryBatch(); await refresh(); });
  };

  const batchIds = new Set(batch?.ids ?? []);
  const justRemembered = memories.filter((m) => batchIds.has(m.id));
  const rest = memories.filter((m) => !batchIds.has(m.id));
  const row = (m: Memory) => (
    <div key={m.id} class="bean-memory-item">
      <input
        class="bean-input bean-memory-input"
        value={m.text}
        onInput={(e) => editMemory(m.id, (e.target as HTMLInputElement).value)}
        onBlur={() => commitMemory(m)}
      />
      <button type="button" class="bean-memory-del" onClick={() => deleteMemory(m.id)} aria-label="Delete">×</button>
    </div>
  );

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

      {batch && justRemembered.length > 0 ? (
        <div class="bean-memory-just" ref={justRef}>
          <div class="bean-memory-just-head">
            <span class="bean-memory-group-label">Just remembered · {ago(batch.at)}</span>
            <button type="button" class="bean-btn bean-btn--ghost" onClick={undoBatch}>Undo</button>
          </div>
          {justRemembered.map(row)}
        </div>
      ) : null}

      <div class="bean-memory-group-label">About you</div>
      {rest.filter((m) => !m.projectPath).length === 0 ? (
        <div class="bean-memory-empty">Nothing yet.</div>
      ) : (
        rest.filter((m) => !m.projectPath).map(row)
      )}
      <button type="button" class="bean-btn bean-btn--ghost" onClick={() => addMemory(undefined)}>+ Add about you</button>

      {projects.filter((p) => rest.some((m) => m.projectPath === p.path)).map((p) => (
        <div key={p.path}>
          <div class="bean-memory-group-label">{p.name}</div>
          {rest.filter((m) => m.projectPath === p.path).map(row)}
        </div>
      ))}
    </div>
  );
}
