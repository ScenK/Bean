// packages/app/src/renderer/components/persona/PersonaWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { PersonaPanel } from "./PersonaPanel.js";
import type { Theme } from "../../../channels.js";

export function PersonaWindow() {
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
      <PersonaPanel />
    </div>
  );
}
