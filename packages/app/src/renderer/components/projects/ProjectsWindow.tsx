import { useEffect, useState } from "preact/hooks";
import { ProjectsPanel } from "./ProjectsPanel.js";
import type { Project, LaunchMode } from "@bean/core";
import type { Theme } from "../../../channels.js";

export function ProjectsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const launch = (mode: LaunchMode, project: Project, prompt?: string): void => {
    window.bean.launch({ mode, projectPath: project.path, prompt });
  };

  return (
    <div class="bean-dashboard">
      <ProjectsPanel onLaunch={launch} />
    </div>
  );
}
