import { useEffect, useRef, useState } from "preact/hooks";
import type { DismissReason, MindItem } from "@bean/core";
import { SEEDS_SHOWN, activeSeeds, isQuietHours, markSeen, readSeen, refreshSeeds, replyCrossed, type SeedsView } from "./seeds.js";

/** The host's message without Electron's "Error invoking remote method" wrapper (as RoutineBuilder's
 * ipcErrorMessage — not imported, so the chat bundle doesn't pull in the Sprout builder). */
const hostMessage = (e: unknown): string | undefined =>
  e instanceof Error ? (/^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/.exec(e.message)?.[1] ?? e.message) : undefined;

/** How long a seed just crossed off stays struck through before it fades out. */
export const SEED_FADE_MS = 2000;

const REASONS: { value: DismissReason | undefined; label: string }[] = [
  { value: "not-interested", label: "Not interested" },
  { value: "wrong", label: "That's wrong" },
  { value: undefined, label: "Just let it go" },
];

/** Home's Seeds popover (#1159): Bean's working list with Done / Let it go / Discuss, under the header
 * chip. Closes on Esc, an outside click, or Discuss (which prefills the composer — never sends). */
export function SeedsPopover({ view, onDiscuss, onClose }: {
  view: SeedsView;
  onDiscuss: (seed: MindItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [fading, setFading] = useState<MindItem[]>([]);
  const [toast, setToast] = useState<{ text: string; item: MindItem } | null>(null);
  const [letting, setLetting] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Crossed off from a reply: a snapshot at open, so each shows once (marked seen right away).
  const [crossed] = useState(() => replyCrossed(view.items, readSeen()));
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  // Crossed off or let go here: off the active list at once, before the re-read lands.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    markSeen(crossed.map((s) => `${s.id}:${s.version}`));
    const key = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const down = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest?.("[data-seeds-toggle]")) onClose();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("mousedown", down);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("mousedown", down);
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);

  const act = async (fn: () => Promise<MindItem | undefined>, after: (it: MindItem) => void): Promise<void> => {
    setError("");
    try {
      const it = await fn();
      if (it) after(it);
      else setError("That seed was already closed.");
    } catch (e) {
      setError(hostMessage(e) ?? "Couldn't update that seed.");
    }
    refreshSeeds();
  };
  const done = (s: MindItem): void => void act(() => window.bean.resolveSeed(s.id, "done", s.version), (it) => {
    setGone((g) => new Set([...g, it.id]));
    setFading((f) => [...f, it]);
    timers.current.push(setTimeout(() => setFading((f) => f.filter((x) => x.id !== it.id)), SEED_FADE_MS));
    setToast({ text: "Crossed off", item: it });
  });
  const letGo = (s: MindItem, reason: DismissReason | undefined): void => void act(() => window.bean.resolveSeed(s.id, "dismissed", s.version, reason), (it) => {
    setLetting(null);
    setGone((g) => new Set([...g, it.id]));
    setToast({ text: "Let go", item: it });
  });
  const undo = (s: MindItem): void => void act(() => window.bean.undoSeed(s.id, s.version), () => {
    setFading((f) => f.filter((x) => x.id !== s.id));
    setGone((g) => new Set([...g].filter((id) => id !== s.id)));
    setUndone((u) => new Set([...u, s.id]));
    setToast((t) => (t?.item.id === s.id ? null : t));
  });

  const active = activeSeeds(view.items).filter((s) => !gone.has(s.id)).slice(0, SEEDS_SHOWN);
  const crossedShown = crossed.filter((s) => !undone.has(s.id) && !active.some((a) => a.id === s.id));
  const source = (s: MindItem) => (s.sourceSprout ? (
    <button
      type="button" class="bean-seed-source" title="Open the run in the Dashboard"
      onClick={() => void window.bean.openComponent("dashboard", { routine: s.sourceSprout!, ...(s.sourceStartedAt ? { startedAt: s.sourceStartedAt } : {}) })}
    >🌱 {s.sourceSprout}</button>
  ) : null);

  return (
    <div class="bean-seeds-pop" ref={ref} role="dialog" aria-label="Seeds">
      <div class="bean-seeds-head">
        <span class="bean-seeds-title">Seeds</span>
        {isQuietHours(new Date()) ? <span class="bean-seeds-quiet">Quiet until 7 AM</span> : null}
      </div>
      {crossedShown.map((s) => (
        <div key={`c-${s.id}`} class="bean-seed bean-seed--crossed">
          <span class="bean-seed-text">{s.text}</span>
          <span class="bean-seed-note">
            Crossed off from your reply · <button type="button" class="bean-seed-link" onClick={() => undo(s)}>Undo</button>
          </span>
        </div>
      ))}
      {active.length === 0 && fading.length === 0 && crossedShown.length === 0 ? (
        <div class="bean-seeds-empty">
          No seeds yet. Let a sprout share what it finds and I'll plant what's worth watching.{" "}
          <button type="button" class="bean-seed-link" onClick={() => void window.bean.openComponent("routines")}>Choose sprouts…</button>
        </div>
      ) : null}
      {active.map((s) => (
        <div key={s.id} class="bean-seed">
          <button type="button" class="bean-seed-text bean-seed-body" title="Discuss" onClick={() => onDiscuss(s)}>{s.text}</button>
          {source(s)}
          {letting === s.id ? (
            <span class="bean-seed-reasons">
              {REASONS.map((r) => (
                <button key={r.label} type="button" class="bean-seed-link" onClick={() => letGo(s, r.value)}>{r.label}</button>
              ))}
            </span>
          ) : (
            <span class="bean-seed-actions">
              <button type="button" class="bean-seed-act" aria-label={`Done: ${s.text}`} title="Done" onClick={() => done(s)}>✓</button>
              <button type="button" class="bean-seed-act" aria-label={`Let it go: ${s.text}`} title="Let it go" onClick={() => setLetting(s.id)}>✕</button>
            </span>
          )}
        </div>
      ))}
      {fading.map((s) => (
        <div key={`f-${s.id}`} class="bean-seed bean-seed--crossed bean-seed--fading">
          <span class="bean-seed-text">{s.text}</span>
        </div>
      ))}
      {error ? <div class="bean-seeds-error" role="alert">{error}</div> : null}
      {toast ? (
        <div class="bean-seeds-toast" role="status">
          {toast.text} · <button type="button" class="bean-seed-link" onClick={() => undo(toast.item)}>Undo</button>
        </div>
      ) : null}
    </div>
  );
}
