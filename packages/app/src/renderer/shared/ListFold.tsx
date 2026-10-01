import { useState } from "preact/hooks";

// Whether a split window's list column is folded away so the detail pane gets the full width.
// A renderer-only view pref (see .memory/convention-renderer-view-prefs-in-localstorage.md):
// only an exact stored "true" folds; a missing, invalid, or unreadable value means unfolded, and
// a failed write still toggles for this session.
export function readFolded(key: string): boolean {
  try { return localStorage.getItem(key) === "true"; } catch { return false; }
}

export function useListFold(key: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => readFolded(key));
  const toggle = (): void => {
    const next = !folded;
    try { localStorage.setItem(key, String(next)); } catch { /* private mode / quota: still folds this session */ }
    setFolded(next);
  };
  return [folded, toggle];
}

// Sits in the window's top drag strip just right of the traffic lights, in the same spot folded
// or not, so there's always a way back.
export function ListFoldToggle({ folded, onToggle, listId }: { folded: boolean; onToggle: () => void; listId: string }) {
  const label = folded ? "Show list" : "Hide list";
  return (
    <button
      type="button"
      class="bean-list-fold-toggle"
      aria-label={label}
      title={label}
      aria-expanded={!folded}
      aria-controls={listId}
      onClick={(e) => {
        // Folding hides the list; if focus was inside it, keep it on the toggle instead of
        // dropping it to <body>.
        if (!folded && document.getElementById(listId)?.contains(document.activeElement)) {
          (e.currentTarget as HTMLButtonElement).focus();
        }
        onToggle();
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
        <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" stroke-width="1.3" />
        {!folded && <rect x="2.5" y="3.5" width="3" height="9" fill="currentColor" />}
      </svg>
    </button>
  );
}
