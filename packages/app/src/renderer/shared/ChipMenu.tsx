import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

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

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div class="bean-chip-menu" ref={ref}>
      <button
        type="button"
        class={`bean-chip-menu-trigger${chipClass ? ` ${chipClass}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {chipLabel} <span class="bean-chip-menu-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div class="bean-chip-menu-panel" style={menuWidth ? { width: `${menuWidth}px` } : undefined}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
