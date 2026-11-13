import { useEffect, useState } from "preact/hooks";
import type { AliasResult } from "@bean/core";
import type { DestinationView } from "@bean/host";

// Settings → ChatOps → Destinations (#686). Platform names are untrusted display data: they only
// ever land in text nodes / attributes, never as markup.

const PLATFORM = { discord: "Discord", teams: "Teams" } as const;
const keyOf = (r: DestinationView): string => `${r.surface}:${r.conversationId}`;
const seen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
/** What a row is called in a picker or an unnamed row: label, else the who-talks-there hint, else an id tail. */
const display = (r: DestinationView): string => r.label ?? r.hint ?? `${r.kind} …${r.conversationId.slice(-6)}`;
const details = (r: DestinationView): string =>
  [r.platformName && r.platformName !== r.label ? r.platformName : undefined, r.parentName, r.kind].filter(Boolean).join(" · ");

type Mode = { kind: "name"; key: string; draft: string } | { kind: "move"; key: string } | undefined;

export function DestinationsList() {
  const [rows, setRows] = useState<DestinationView[] | undefined>(undefined);
  const [mode, setMode] = useState<Mode>(undefined);
  const [error, setError] = useState<{ key: string; text: string } | undefined>(undefined);

  const refresh = (): Promise<void> => window.bean.destinationsList().then(setRows, () => setRows([]));
  useEffect(() => { void refresh(); }, []);

  const run = async (key: string, op: () => Promise<AliasResult>): Promise<void> => {
    try {
      const res = await op();
      if (!res.ok) { setError({ key, text: res.error }); return; }
      setError(undefined);
      setMode(undefined);
      await refresh();
    } catch (err) {
      setError({ key, text: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!rows) return null;
  if (!rows.length) {
    return <div class="bean-dest-empty">No conversations yet. Mention Bean in a channel or chat once and it shows up here.</div>;
  }

  const unnamed = rows.filter((r) => !r.alias);
  const named = (s: "discord" | "teams"): DestinationView[] => rows.filter((r) => r.alias && r.surface === s);

  const nameEditor = (r: DestinationView, draft: string) => {
    const save = (): void => { void run(keyOf(r), () => window.bean.destinationsName(r.surface, r.conversationId, draft)); };
    return (
      <div class="bean-dest-edit">
        <input
          class="bean-input bean-dest-input"
          type="text"
          value={draft}
          maxLength={64}
          aria-label="Destination name"
          placeholder="Name it…"
          ref={(el) => el?.focus()}
          onInput={(e) => setMode({ kind: "name", key: keyOf(r), draft: (e.target as HTMLInputElement).value })}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setMode(undefined); setError(undefined); } }}
        />
        <button type="button" class="bean-btn bean-btn--ghost" onClick={save}>Save</button>
        <button type="button" class="bean-btn bean-btn--ghost" onClick={() => { setMode(undefined); setError(undefined); }}>Cancel</button>
      </div>
    );
  };

  const moveEditor = (r: DestinationView) => {
    const targets = rows.filter((t) => t.surface === r.surface && keyOf(t) !== keyOf(r));
    return (
      <div class="bean-dest-edit">
        <select
          class="bean-input bean-dest-input"
          aria-label={`Move "${r.alias}" to`}
          value=""
          onChange={(e) => {
            const id = (e.target as HTMLSelectElement).value;
            if (id) void run(keyOf(r), () => window.bean.destinationsRetarget(r.alias!, r.surface, id));
          }}
        >
          <option value="">{targets.length ? "Move to…" : `No other ${PLATFORM[r.surface]} conversation`}</option>
          {targets.map((t) => <option key={t.conversationId} value={t.conversationId}>{display(t)}</option>)}
        </select>
        <button type="button" class="bean-btn bean-btn--ghost" onClick={() => { setMode(undefined); setError(undefined); }}>Cancel</button>
      </div>
    );
  };

  const row = (r: DestinationView) => {
    const key = keyOf(r);
    const editing = mode?.key === key ? mode : undefined;
    const locked = r.usedBy.length > 0;
    const lockedWhy = locked ? `Used by ${r.usedBy.join(", ")} — move it to another conversation instead.` : undefined;
    return (
      <div key={key} class="bean-settings-row bean-dest-row" data-destination={key}>
        <div class="bean-dest-main">
          <div class="bean-dest-title">{r.alias ?? display(r)}</div>
          <div class="bean-dest-meta">
            {[
              r.alias ? details(r) : [PLATFORM[r.surface], details(r)].filter(Boolean).join(" · "),
              `seen ${seen(r.lastSeen)}`,
              locked ? `used by ${plural(r.usedBy.length, "sprout")}` : undefined,
            ].filter(Boolean).join(" · ")}
          </div>
          {editing?.kind === "name" && nameEditor(r, editing.draft)}
          {editing?.kind === "move" && moveEditor(r)}
          {error?.key === key && <div class="bean-dest-error" role="alert">{error.text}</div>}
        </div>
        {!editing && (
          <div class="bean-dest-actions">
            {r.alias ? [
              <span key="rename" title={lockedWhy}>
                <button type="button" class="bean-btn bean-btn--ghost" disabled={locked}
                  onClick={() => { setError(undefined); setMode({ kind: "name", key, draft: r.alias! }); }}>Rename</button>
              </span>,
              <button key="move" type="button" class="bean-btn bean-btn--ghost" title="Point this name at another conversation"
                onClick={() => { setError(undefined); setMode({ kind: "move", key }); }}>Move</button>,
              <span key="clear" title={lockedWhy}>
                <button type="button" class="bean-btn bean-btn--ghost" disabled={locked}
                  onClick={() => void run(key, () => window.bean.destinationsClear(r.surface, r.conversationId))}>Clear</button>
              </span>,
            ] : (
              <button type="button" class="bean-btn bean-btn--ghost"
                onClick={() => { setError(undefined); setMode({ kind: "name", key, draft: "" }); }}>Name</button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div class="bean-dest">
      {unnamed.length > 0 && [
        <div key="unnamed-head" class="bean-dest-group">{unnamed.length} unnamed — name them to send there</div>,
        ...unnamed.map(row),
      ]}
      {(["discord", "teams"] as const).map((s) => {
        const group = named(s);
        return group.length ? [<div key={`${s}-head`} class="bean-dest-group">{PLATFORM[s]}</div>, ...group.map(row)] : null;
      })}
    </div>
  );
}
