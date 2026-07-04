import { useEffect, useState } from "preact/hooks";
import { NotesPanel } from "./NotesPanel.js";
import type { Theme } from "../../../channels.js";

export function NotesWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div class="bean-dashboard">
      <NotesPanel />
    </div>
  );
}
