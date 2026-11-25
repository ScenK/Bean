import { useEffect, useRef } from "preact/hooks";

/** `n` = the window's New action (chat, skill, project, note, sprout), only while nothing takes
 *  typing (a composer, a search box, an editor) and `blocked` is false. */
export function useNewShortcut(onNew: () => void, blocked = false): void {
  const latest = useRef({ onNew, blocked });
  latest.current = { onNew, blocked };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "n" || e.repeat || e.isComposing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || latest.current.blocked) return;
      const el = e.target;
      if (el instanceof HTMLElement && (el.isContentEditable || el.closest("input, textarea, select"))) return;
      e.preventDefault();
      latest.current.onNew();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
