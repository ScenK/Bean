// packages/app/src/renderer/components/skills/SkillsWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { SkillsPanel } from "./SkillsPanel.js";
import type { RouteSuggestion } from "@bean/core";
import type { Theme } from "../../../channels.js";

export function SkillsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const onRunSkill = (run: RouteSuggestion): void => {
    window.bean.proposeRun(run);
  };

  return (
    <div class="bean-dashboard">
      <SkillsPanel onRunSkill={onRunSkill} />
    </div>
  );
}
