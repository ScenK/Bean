import { useEffect, useState } from "preact/hooks";
import { RoutinesPanel } from "./RoutinesPanel.js";
import type { Theme } from "../../../channels.js";

export function RoutinesWindow() {
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
      <RoutinesPanel />
    </div>
  );
}
