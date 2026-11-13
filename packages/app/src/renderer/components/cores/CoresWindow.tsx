import { useEffect, useState } from "preact/hooks";
import type { Theme } from "../../../channels.js";

// Only a Mac runs a local core; elsewhere the shell is remote-only.
const IS_MAC = navigator.userAgent.includes("Macintosh");

/** Add a core (#810): what the avatar opens while no core is attached. Shell-only — it never calls a
 * core channel. Remote cores (SSH) are added here by #811. */
export function CoresWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const useThisMac = (): void => {
    setStarting(true);
    window.bean.useLocalCore();
  };

  return (
    <div class="bean-dashboard">
      <div class="bean-about bean-cores">
        <div class="bean-about-name">Add a core</div>
        <p class="bean-about-desc">
          Bean isn't attached to a core. The core is the part that chats, remembers, and runs your sprouts.
        </p>
        {IS_MAC && (
          <div class="bean-about-update">
            <button class="bean-btn" disabled={starting} onClick={useThisMac}>
              {starting ? "Restarting Bean…" : "Use this Mac"}
            </button>
            <div class="bean-about-update-msg">Runs the core on this Mac. Bean restarts.</div>
          </div>
        )}
      </div>
    </div>
  );
}
