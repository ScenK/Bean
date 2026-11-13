import { useEffect, useRef, useState } from "preact/hooks";
import { PERSONA_TAGS, type Persona, type PersonaTag } from "@bean/core/persona";
import type { DreamDigest, Memory, Project } from "@bean/core";
import { memorySections, OWNER_CATEGORY, OWNER_PIN_LIMIT } from "@bean/core/memory";
import { projectsByName } from "@bean/core/project-select";
import type { MemoryBatch } from "@bean/host";

const ago = (iso: string): string => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/** Below this many owner rows, one flat list (category shown per row) beats a page of headings. */
const FLAT_BELOW = 8;

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
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [catDraft, setCatDraft] = useState<{ id: string; value: string } | undefined>(undefined);
  const [memError, setMemError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [batch, setBatch] = useState<MemoryBatch | undefined>(undefined);
  const [dream, setDream] = useState<DreamDigest | undefined>(undefined);
  const [dreamDetails, setDreamDetails] = useState<{ before: string[]; after?: string }[] | undefined>(undefined);
  const [dreamNote, setDreamNote] = useState<string | undefined>(undefined);
  const justRef = useRef<HTMLDivElement>(null);
  const addedIds = useRef(new Set<string>());

  const refresh = async (): Promise<void> => {
    const [p, mem, projs, b, d, owners] = await Promise.all([
      window.bean.getPersona(),
      window.bean.listMemories(),
      window.bean.listProjects(),
      window.bean.getMemoryBatch(),
      window.bean.getLastDream(),
      window.bean.memoryOwnerIds(),
    ]);
    setOwnerIds(owners);
    setDream(d);
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
  const deleteMemory = (id: string): void => forget([id]);
  const forget = (ids: string[]): void => {
    setMemories((prev) => prev.filter((m) => !ids.includes(m.id)));
    void run(() => window.bean.deleteMemories(ids));
  };
  // Typing goes to a draft, not the row: changing the row's category regroups it, which would
  // remount the focused input mid-word. The row moves only on commit (blur/Enter).
  const commitCategory = (m: Memory): void => {
    if (catDraft?.id !== m.id) return;
    const category = catDraft.value.trim();
    setCatDraft(undefined);
    if (category === (m.category ?? "")) return;
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, category } : x)));
    // Main sanitizes; refresh so the row lands under the stored (normalized) heading.
    void run(async () => { await window.bean.updateMemoryCategory(m.id, category || null); await refresh(); });
  };
  const renameCategory = (from: string, to: string): void => {
    if (to.trim() === from) return;
    void run(async () => { await window.bean.renameMemoryCategory(from, to); await refresh(); });
  };
  const addMemory = (projectPath?: string): void => {
    const entry: Memory = { id: crypto.randomUUID(), text: "", projectPath, createdAt: new Date().toISOString() };
    addedIds.current.add(entry.id);
    setMemories((prev) => [...prev, entry]);
    setQuery(""); // the new row is empty — a live filter would hide it
    void run(() => window.bean.appendMemories([entry]));
  };
  const undoBatch = (): void => {
    void run(async () => { await window.bean.undoMemoryBatch(); await refresh(); });
  };

  const undoDream = (): void => {
    void run(async () => {
      const { skipped } = await window.bean.undoLastDream();
      setDreamDetails(undefined);
      setDreamNote(skipped > 0 ? `${skipped} ${skipped === 1 ? "entry" : "entries"} changed since — kept your edit` : undefined);
      await refresh();
    });
  };
  const toggleDreamDetails = (): void => {
    if (dreamDetails) { setDreamDetails(undefined); return; }
    void run(async () => setDreamDetails(await window.bean.dreamDetails()));
  };
  const dreamSummary = dream
    ? [dream.merged ? `merged ${dream.merged}` : "", dream.rewritten ? `rewrote ${dream.rewritten}` : "", dream.removed ? `removed ${dream.removed}` : ""]
      .filter(Boolean).join(", ")
    : "";

  const needle = query.trim().toLowerCase();
  // Newest first; rows added in this session stay last, next to the "+ Add" button that made them.
  // Pinned by id, not by empty text: typing the first character mustn't move the focused row.
  const pinned = (m: Memory): number => Number(addedIds.current.has(m.id));
  const newestFirst = (a: Memory, b: Memory): number => pinned(a) - pinned(b) || b.createdAt.localeCompare(a.createdAt);
  const shown = (needle ? memories.filter((m) => m.text.toLowerCase().includes(needle)) : [...memories]).sort(newestFirst);
  const batchIds = new Set(batch?.ids ?? []);
  const justRemembered = shown.filter((m) => batchIds.has(m.id));
  const sections = memorySections(shown.filter((m) => !batchIds.has(m.id)), ownerIds);
  const categories = [...new Set(memories.flatMap((m) => (m.category ? [m.category] : [])))].sort();
  const youRows = memories.filter((m) => m.category === OWNER_CATEGORY);
  const alwaysOn = new Set(youRows.slice(-OWNER_PIN_LIMIT).map((m) => m.id)); // loadMemories is oldest-first
  // Headings only once the whole owner list (not the filtered view) is big enough to need them.
  const flat = memorySections(memories, ownerIds).ownerCount < FLAT_BELOW;
  const row = (m: Memory, withCategory = false) => (
    <div key={m.id} data-memory-id={m.id} class={`bean-memory-item${m.category === OWNER_CATEGORY && !alwaysOn.has(m.id) ? " bean-memory-item--dim" : ""}`}>
      <input
        class="bean-input bean-memory-input"
        value={m.text}
        onInput={(e) => editMemory(m.id, (e.target as HTMLInputElement).value)}
        onBlur={() => commitMemory(m)}
      />
      {withCategory ? (
        <input
          class="bean-input bean-memory-cat"
          list="bean-memory-categories"
          placeholder="Category"
          aria-label="Category"
          value={catDraft?.id === m.id ? catDraft.value : (m.category ?? "")}
          onInput={(e) => setCatDraft({ id: m.id, value: (e.target as HTMLInputElement).value })}
          onBlur={() => commitCategory(m)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      ) : null}
      {m.subjectId ? <span class="bean-memory-private" title="Private to one chat member" aria-label="Private">🔒</span> : null}
      <span class="bean-memory-date" title={new Date(m.createdAt).toLocaleString()}>
        {new Date(m.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
      </span>
      <button type="button" class="bean-memory-del" onClick={() => deleteMemory(m.id)} aria-label="Delete">×</button>
    </div>
  );
  const ownerRow = (m: Memory) => row(m, true);
  const heading = (category: string) => {
    if (category === OWNER_CATEGORY) {
      return (
        <div class="bean-memory-group-label">
          You · {Math.min(youRows.length, OWNER_PIN_LIMIT)} of {OWNER_PIN_LIMIT} always on
        </div>
      );
    }
    if (category === "") return <div class="bean-memory-group-label">Uncategorized</div>;
    return (
      <input
        key={category}
        class="bean-memory-group-label bean-memory-cat-name"
        aria-label={`Rename category ${category}`}
        defaultValue={category}
        onBlur={(e) => renameCategory(category, (e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    );
  };
  const ownerGroups = sections.owner;
  const hasYou = ownerGroups.some((g) => g.category === OWNER_CATEGORY);

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
      <input
        type="search"
        class="bean-input bean-input--boxed bean-memory-search"
        placeholder="Search memories"
        aria-label="Search memories"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />

      {batch && justRemembered.length > 0 ? (
        <div class="bean-memory-just" ref={justRef}>
          <div class="bean-memory-just-head">
            <span class="bean-memory-group-label">Just remembered · {ago(batch.at)}</span>
            <button type="button" class="bean-btn bean-btn--ghost" onClick={undoBatch}>Undo</button>
          </div>
          {justRemembered.map(ownerRow)}
        </div>
      ) : null}

      {dream && !dream.undone ? (
        <div class="bean-memory-just">
          <div class="bean-memory-just-head">
            <span class="bean-memory-group-label">
              Last dream · {new Date(dream.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {dreamSummary}
            </span>
            <span>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={undoDream}>Undo</button>
              <button type="button" class="bean-btn bean-btn--ghost" aria-expanded={dreamDetails !== undefined} onClick={toggleDreamDetails}>
                Details {dreamDetails ? "▾" : "▸"}
              </button>
            </span>
          </div>
          {dreamDetails?.map((g, i) => (
            <div key={i} class="bean-memory-dream-row">
              {g.before.join(" · ")} → {g.after ?? <em>removed</em>}
            </div>
          ))}
        </div>
      ) : null}
      {dreamNote ? <div class="bean-memory-empty">{dreamNote}</div> : null}

      <datalist id="bean-memory-categories">
        {[OWNER_CATEGORY, ...categories.filter((c) => c !== OWNER_CATEGORY)].map((c) => <option key={c} value={c} />)}
      </datalist>
      {flat ? (
        <>
          <div class="bean-memory-group-label">About you</div>
          {ownerGroups.length === 0 ? (
            <div class="bean-memory-empty">{needle ? "No matches." : "Nothing yet."}</div>
          ) : (
            ownerGroups.flatMap((g) => g.rows).sort(newestFirst).map(ownerRow)
          )}
        </>
      ) : (
        <>
          {hasYou ? null : (
            <>
              {heading(OWNER_CATEGORY)}
              <div class="bean-memory-empty">
                {needle ? "No matches." : "Facts here go into every chat — move the ones Bean should always know here"}
              </div>
            </>
          )}
          {ownerGroups.map((g) => (
            <div key={g.category || "-"} class="bean-memory-section">
              {heading(g.category)}
              {g.rows.map(ownerRow)}
            </div>
          ))}
        </>
      )}
      <button type="button" class="bean-btn bean-btn--ghost" onClick={() => addMemory(undefined)}>+ Add about you</button>

      {sections.channels.length > 0 ? <div class="bean-memory-group-label">Channels</div> : null}
      {sections.channels.map((ch) => (
        <details key={ch.sourceId} class="bean-memory-channel">
          <summary>{ch.title} · {ch.rows.length}</summary>
          {ch.rows.map((m) => row(m))}
          <button type="button" class="bean-btn bean-btn--ghost" onClick={() => forget(memories.filter((m) => m.sourceId === ch.sourceId).map((m) => m.id))}>
            Forget all from here
          </button>
        </details>
      ))}

      {sections.others.length > 0 ? (
        <>
          <div class="bean-memory-group-label">Others</div>
          {sections.others.map((m) => row(m))}
        </>
      ) : null}

      {projectsByName(projects).filter((p) => sections.projects.some((m) => m.projectPath === p.path)).map((p) => (
        <div key={p.path}>
          <div class="bean-memory-group-label">{p.name}</div>
          {sections.projects.filter((m) => m.projectPath === p.path).map((m) => row(m))}
        </div>
      ))}
    </div>
  );
}
