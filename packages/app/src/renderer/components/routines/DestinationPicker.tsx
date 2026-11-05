import { useState } from "preact/hooks";
import type { Routine, RoutineChatopsSink } from "@bean/core";
import type { DestinationView } from "../../../destinations.js";

const KIND_GROUP = { channel: "Channels", thread: "Threads", group: "Group chats", meeting: "Meetings", dm: "Direct messages" } as const;
const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface DestinationPickerProps {
  /** A channel-id or destination-name row (never the plain DM or a user DM). */
  sink: RoutineChatopsSink;
  label: string;
  room: string;
  /** Every seen conversation (all platforms) — only this sink's platform's labelled rows are offered. */
  destinations: DestinationView[];
  /** Saved sprouts, to list who a raw id's "Name it" rewrites. */
  routines: Routine[];
  onChange: (sink: RoutineChatopsSink) => void;
  onRemove: () => void;
  /** A raw id was named and rewritten on disk: swap it in the draft too and reload the lists. */
  onNamedRaw: (conversationId: string, alias: string) => void;
  reloadDestinations: () => Promise<void>;
}

/** One chat sink row: a grouped `<select>` of named destinations for the sink's platform, or a
 * legacy raw id (still delivered) with "Name it". Picking an unnamed conversation names it after
 * its label right away; that new name stays editable inline until the picker moves on. */
export function DestinationPicker(p: DestinationPickerProps) {
  const { sink, label, room } = p;
  const transport = sink.transport;
  const mine = p.destinations.filter((d) => d.surface === transport && d.label);
  // The conversation an alias was just created for (editable inline), and the open "Name it".
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const [naming, setNaming] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const rawId = sink.alias === undefined ? (sink.channel ?? "").trim() : "";
  const rawRow = rawId ? mine.find((d) => d.conversationId === rawId) : undefined;
  const rawUsers = rawId
    ? p.routines.filter((r) => (r.sinks.chatops ?? []).some((c) => c.transport === transport && c.channel === rawId)).map((r) => r.name)
    : [];
  const unknownAlias = sink.alias !== undefined && !mine.some((d) => d.alias === sink.alias);

  const pick = async (value: string): Promise<void> => {
    setError("");
    setNaming(undefined);
    setFresh(undefined);
    if (value === "raw") { p.onChange({ transport, channel: "" }); return; }
    if (value.startsWith("alias:")) { p.onChange({ transport, alias: value.slice("alias:".length) }); return; }
    const row = mine.find((d) => `row:${d.conversationId}` === value);
    if (!row?.label) return;
    // Named after its label; a clash with another row's name gets " 2", " 3"….
    for (let n = 1; n <= 5; n++) {
      const alias = n === 1 ? row.label : `${row.label} ${n}`;
      const r = await window.bean.destinationsName(transport, row.conversationId, alias);
      if (r.ok) {
        await p.reloadDestinations();
        p.onChange({ transport, alias: tidy(alias) });
        setFresh(row.conversationId);
        setName(tidy(alias));
        return;
      }
      if (!r.error.includes("already")) { setError(r.error); return; }
    }
    setError(`Couldn't find a free name for "${row.label}" — name it in Settings → ChatOps.`);
  };

  const renameFresh = async (): Promise<void> => {
    const next = tidy(name);
    if (!fresh || next === sink.alias) return;
    const r = await window.bean.destinationsName(transport, fresh, next);
    if (!r.ok) { setError(r.error); return; }
    setError("");
    await p.reloadDestinations();
    p.onChange({ transport, alias: next });
  };

  const nameRaw = async (): Promise<void> => {
    const r = await window.bean.destinationsNameRaw(transport, rawId, name);
    if (!r.ok) { setError(r.error); return; }
    setError("");
    setNaming(undefined);
    p.onNamedRaw(rawId, r.alias);
  };

  const groups = (Object.keys(KIND_GROUP) as (keyof typeof KIND_GROUP)[])
    .map((kind) => ({ kind, rows: mine.filter((d) => d.kind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div class="bean-routines-sink-dest bean-routines-sink-suboption">
      <div class="bean-routines-sink-row">
        <select
          class="bean-routines-chip-select"
          aria-label={`${label} destination`}
          value={sink.alias !== undefined ? `alias:${sink.alias}` : "raw"}
          onChange={(e) => void pick((e.target as HTMLSelectElement).value)}
        >
          <option value="raw">{`Enter a ${room} id…`}</option>
          {unknownAlias ? <option value={`alias:${sink.alias}`}>{`${sink.alias} (unknown)`}</option> : null}
          {groups.map((g) => (
            <optgroup key={g.kind} label={KIND_GROUP[g.kind]}>
              {g.rows.map((d) => (
                <option key={d.conversationId} value={d.alias !== undefined ? `alias:${d.alias}` : `row:${d.conversationId}`}>{d.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {sink.alias === undefined ? (
          <input
            class="bean-input bean-input--boxed"
            aria-label={`${label} ${room} id`}
            placeholder={`${room} id`}
            value={sink.channel}
            onInput={(e) => p.onChange({ transport, channel: (e.target as HTMLInputElement).value })}
          />
        ) : null}
        {rawRow && naming === undefined ? (
          <button
            type="button"
            class="bean-skills-delete-link"
            onClick={() => { setNaming(rawId); setName(rawRow.alias ?? rawRow.label ?? ""); setError(""); }}
          >Name it</button>
        ) : null}
        <button
          type="button"
          class="bean-skills-delete-link"
          aria-label={sink.alias !== undefined ? `Remove ${label} ${room} ${sink.alias}` : `Remove ${label} ${room}`}
          title="Remove"
          onClick={p.onRemove}
        >×</button>
      </div>
      {fresh && sink.alias !== undefined ? (
        <div class="bean-routines-sink-row">
          <input
            class="bean-input bean-input--boxed"
            aria-label="Destination name"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onBlur={() => void renameFresh()}
            onKeyDown={(e) => { if (e.key === "Enter") void renameFresh(); }}
          />
        </div>
      ) : null}
      {naming !== undefined && naming === rawId ? (
        <div class="bean-routines-sink-row">
          <input
            class="bean-input bean-input--boxed"
            aria-label="Destination name"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <button type="button" class="bean-btn" onClick={() => void nameRaw()}>Save name</button>
          <button type="button" class="bean-skills-delete-link" onClick={() => setNaming(undefined)}>Cancel</button>
        </div>
      ) : null}
      {naming !== undefined && naming === rawId ? (
        <div class="bean-routines-section-note">
          {rawUsers.length > 0
            ? `Replaces ${rawId} with the name in: ${rawUsers.join(", ")} (and this draft).`
            : `Replaces ${rawId} with the name in this draft.`}
        </div>
      ) : null}
      {error ? <div class="bean-routines-section-note" role="alert">{error}</div> : null}
    </div>
  );
}
