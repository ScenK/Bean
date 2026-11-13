// The shell's own shortcut key (#813): Cmd on macOS, Ctrl on Windows/Linux. This is the machine the
// window runs on — the core's platform (capabilities.ts) can differ. Unknown platforms (jsdom) keep Cmd.
const CTRL = /^(Win|Linux)/.test(navigator.platform);

/** The key's `KeyboardEvent.key` name, for hover-while-held effects. */
export const MOD_KEY = CTRL ? "Control" : "Meta";
/** How UI copy names it: "⌘-click" / "Ctrl-click". */
export const MOD_LABEL = CTRL ? "Ctrl" : "⌘";

/** Cmd held on macOS, Ctrl elsewhere. */
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (CTRL ? e.ctrlKey : e.metaKey);
