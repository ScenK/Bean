import { useEffect, useState } from "preact/hooks";
import type { AppInfo, Theme } from "../../../channels.js";

export function AboutWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [info, setInfo] = useState<AppInfo | undefined>(undefined);
  const year = new Date().getFullYear();

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.getAppInfo().then(setInfo);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  return (
    <div class="bean-dashboard">
      <div class="bean-about">
        <div class="bean-about-name">Bean</div>
        <div class="bean-about-version">v{info?.version ?? "…"}</div>
        <p class="bean-about-desc">{info?.description ?? ""}</p>
        <div class="bean-about-meta">
          <div>Author · {info?.author ?? "Scen.K"}</div>
          <div>© {year} {info?.author ?? "Scen.K"} in San Antonio</div>
        </div>
      </div>
    </div>
  );
}
