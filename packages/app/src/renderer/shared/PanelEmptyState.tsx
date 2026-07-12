// Shared blank-state for the right-hand detail pane across Skills/Notes/Projects/Routines —
// nothing auto-selected, so this is what greets you until you pick something. The mark below
// is the same coffee-bean path as the avatar orb (see orb.ts BEAN_SVG), rendered in a flat
// grey so it reads as a quiet watermark rather than the lit-up mascot.
export function PanelEmptyState({ message }: { message: string }) {
  return (
    <div class="bean-panel-empty">
      <svg class="bean-panel-empty-art" viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <path
          class="bean-panel-empty-body"
          d="M18 3C11 3 5.5 8 5 15C4.5 22 9 29 16 31.5C23 34 30 29.5 32 22.5C34 15.5 30 7 24 4.5C22.3 3.5 20.2 3 18 3Z"
        />
        <path
          class="bean-panel-empty-crease-line"
          d="M12 9C10 12 10 17 12 20"
          stroke-width="2.5"
          stroke-linecap="round"
        />
        <path class="bean-panel-empty-crease" d="M18 7C18 7 15 14 18 22C21 14 18 7 18 7Z" />
      </svg>
      <div class="bean-panel-empty-text">{message}</div>
    </div>
  );
}
