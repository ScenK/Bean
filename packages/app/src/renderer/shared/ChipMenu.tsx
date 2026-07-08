import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

const GAP = 6; // matches the old CSS's `top: calc(100% + 6px)`
const VIEWPORT_MARGIN = 8;

// Reusable "click a chip, a floating menu opens below it" popover — the project and model
// pickers in ProposalCard both open one of these instead of the old always-visible chip row.
export function ChipMenu({
  chipLabel,
  chipClass,
  disabled,
  menuWidth,
  children,
}: {
  chipLabel: ComponentChildren;
  chipClass?: string;
  disabled?: boolean;
  menuWidth?: number;
  children: (close: () => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Screen-space position, computed from the trigger's rect rather than left to CSS
  // `position: absolute` — the plan/chat windows clip an absolutely-positioned descendant
  // that overflows a scrolling/overflow:hidden ancestor (bean-dashboard, bean-plan), which cut
  // off the model menu once it had enough rows to not fit below the chip. `position: fixed`
  // escapes that clipping (its containing block is the viewport, not those ancestors).
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Recompute on open (and on resize, in case the window is resized while the menu is open) —
  // measures the actual panel height so it can flip above the trigger when there's no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const panelHeight = panelRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - rect.bottom - GAP;
      const openUp = panelHeight > spaceBelow && rect.top - GAP > spaceBelow;
      const width = menuWidth ?? Math.max(rect.width, 260);
      const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN);
      const top = openUp ? rect.top - GAP - panelHeight : rect.bottom + GAP;
      setPos({ top, left, openUp });
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open, menuWidth]);

  return (
    <div class="bean-chip-menu" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        class={`bean-chip-menu-trigger${chipClass ? ` ${chipClass}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {chipLabel} <span class="bean-chip-menu-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          class="bean-chip-menu-panel"
          style={{
            width: menuWidth ? `${menuWidth}px` : undefined,
            // Invisible until pos is measured (first paint) — avoids a one-frame flash at the
            // default top:0/left:0 before reposition() runs.
            visibility: pos ? "visible" : "hidden",
            top: pos ? `${pos.top}px` : 0,
            left: pos ? `${pos.left}px` : 0,
          }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
