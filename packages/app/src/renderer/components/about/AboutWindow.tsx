import { useEffect, useRef, useState } from "preact/hooks";
import type { AppInfo, Theme, UpdateStatus } from "../../../channels.js";

type UpdateUiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; version: string; notes: string }
  | { phase: "installing" }
  | { phase: "error"; message: string; retry: "check" | "install" };

export function AboutWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [info, setInfo] = useState<AppInfo | undefined>(undefined);
  const [update, setUpdate] = useState<UpdateUiState>({ phase: "idle" });
  const year = new Date().getFullYear();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.getAppInfo().then(setInfo);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // Grow the window to fit content instead of clipping it (e.g. once an update notice appears
  // and pushes the install button below the fixed window height).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) window.bean.resizeWindowToContent(entry.target.scrollHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const checkForUpdates = async (): Promise<void> => {
    setUpdate({ phase: "checking" });
    const result: UpdateStatus = await window.bean.checkForUpdate();
    if (result.status === "up-to-date") setUpdate({ phase: "up-to-date" });
    else if (result.status === "available") setUpdate({ phase: "available", version: result.version, notes: result.notes });
    else setUpdate({ phase: "error", message: result.message, retry: "check" });
  };

  const installUpdate = async (): Promise<void> => {
    setUpdate({ phase: "installing" });
    const result = await window.bean.installUpdate();
    // On success the app exits before this resolves — only an error surfaces here.
    if (result?.status === "error") setUpdate({ phase: "error", message: result.message, retry: "install" });
  };

  return (
    <div class="bean-dashboard" ref={rootRef}>
      <div class="bean-about">
        <div class="bean-about-name">Bean</div>
        <div class="bean-about-version">v{info?.version ?? "…"}</div>
        <p class="bean-about-desc">{info?.description ?? ""}</p>
        <div class="bean-about-meta">
          <div>Author · {info?.author ?? "Scen.K"}</div>
          <div>© {year} {info?.author ?? "Scen.K"} in San Antonio</div>
        </div>
        {info && !info.isPackaged && (
          <div class="bean-about-update-msg">Updates aren't available in a dev build.</div>
        )}
        {info?.isPackaged && (
          <div class="bean-about-update">
            {update.phase === "idle" && (
              <button class="bean-btn" onClick={checkForUpdates}>Check for Updates</button>
            )}
            {update.phase === "checking" && (
              <button class="bean-btn" disabled>Checking for updates…</button>
            )}
            {update.phase === "up-to-date" && (
              <>
                <div class="bean-about-update-msg">You're up to date.</div>
                <button class="bean-btn bean-btn--ghost" onClick={checkForUpdates}>Check again</button>
              </>
            )}
            {update.phase === "available" && (
              <>
                <div class="bean-about-update-msg">Version {update.version} is available.</div>
                <p class="bean-about-update-notes">{update.notes}</p>
                <button class="bean-btn" onClick={installUpdate}>Install &amp; Relaunch</button>
              </>
            )}
            {update.phase === "installing" && (
              <button class="bean-btn" disabled>Installing…</button>
            )}
            {update.phase === "error" && (
              <>
                <div class="bean-about-update-error">{update.message}</div>
                <button
                  class="bean-btn bean-btn--ghost"
                  onClick={() => (update.retry === "install" ? installUpdate() : checkForUpdates())}
                >
                  Retry
                </button>
                <a
                  class="bean-about-update-link"
                  href="#"
                  onClick={(e) => { e.preventDefault(); window.bean.openUpdateReleasePage(); }}
                >
                  View releases on GitHub
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
