import { useEffect, useState } from "preact/hooks";
import type { ConfigView } from "../../../channels.js";
import type { Theme } from "../../../channels.js";

type SaveState = "idle" | "saving" | "saved" | "error";

const PATH_LABELS: { key: keyof ConfigView["paths"]; label: string }[] = [
  { key: "config", label: "Config" },
  { key: "skills", label: "Skills" },
  { key: "projects", label: "Projects" },
  { key: "persona", label: "Persona" },
];

export function SettingsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [terminalApp, setTerminalApp] = useState("");
  const [editorApp, setEditorApp] = useState("");
  const [paths, setPaths] = useState<ConfigView["paths"] | undefined>(undefined);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.getConfig().then((c: ConfigView) => {
      setApiKey(c.openaiApiKey);
      setModel(c.model);
      setTerminalApp(c.terminalApp);
      setEditorApp(c.editorApp);
      setPaths(c.paths);
    });
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const onSave = async (): Promise<void> => {
    setSave("saving");
    setError(undefined);
    try {
      await window.bean.saveConfig({
        openaiApiKey: apiKey.trim(), model: model.trim(),
        terminalApp: terminalApp.trim(), editorApp: editorApp.trim(),
      });
      setSave("saved");
    } catch (err) {
      setSave("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const browseTerminalApp = async (): Promise<void> => {
    const path = await window.bean.pickTerminalApp();
    if (path) { setTerminalApp(path); setSave("idle"); }
  };

  const browseEditorApp = async (): Promise<void> => {
    const path = await window.bean.pickEditorApp();
    if (path) { setEditorApp(path); setSave("idle"); }
  };

  return (
    <div class="bean-dashboard">
      <div class="bean-settings">
        <label class="bean-field">
          <span class="bean-field-label">OPENAI API KEY</span>
          <input
            class="bean-input"
            type="password"
            value={apiKey}
            placeholder="sk-…"
            onInput={(e) => { setApiKey((e.target as HTMLInputElement).value); setSave("idle"); }}
          />
        </label>

        <label class="bean-field">
          <span class="bean-field-label">MODEL NAME</span>
          <input
            class="bean-input"
            type="text"
            value={model}
            placeholder="gpt-4o-mini"
            onInput={(e) => { setModel((e.target as HTMLInputElement).value); setSave("idle"); }}
          />
        </label>

        <label class="bean-field">
          <span class="bean-field-label">TERMINAL APP</span>
          <div class="bean-browse-row">
            <input
              class="bean-input"
              type="text"
              value={terminalApp}
              placeholder="System Default"
              onInput={(e) => { setTerminalApp((e.target as HTMLInputElement).value); setSave("idle"); }}
            />
            <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browseTerminalApp()}>Browse…</button>
          </div>
        </label>

        <label class="bean-field">
          <span class="bean-field-label">EDITOR APP</span>
          <div class="bean-browse-row">
            <input
              class="bean-input"
              type="text"
              value={editorApp}
              placeholder="Not set — required for Open in Editor"
              onInput={(e) => { setEditorApp((e.target as HTMLInputElement).value); setSave("idle"); }}
            />
            <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browseEditorApp()}>Browse…</button>
          </div>
        </label>

        <div class="bean-field">
          <span class="bean-field-label">THEME</span>
          <button
            type="button"
            class="bean-btn"
            onClick={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")}
          >
            {theme === "hearth" ? "Switch to Graphite" : "Switch to Hearth"}
          </button>
        </div>

        <div class="bean-field">
          <span class="bean-field-label">DATA LOCATION (~/.bean)</span>
          <div class="bean-paths">
            {paths
              ? PATH_LABELS.map(({ key, label }) => (
                  <div key={key} class="bean-path-row">
                    <span class="bean-path-label">{label}</span>
                    <span class="bean-path-value">{paths[key]}</span>
                  </div>
                ))
              : <div class="bean-path-row">Loading…</div>}
          </div>
        </div>

        {error ? <div class="bean-persona-error">Save failed: {error}</div> : null}

        <div class="bean-card-actions">
          <button type="button" class="bean-btn" disabled={save === "saving"} onClick={() => void onSave()}>
            {save === "saving" ? "Saving…" : save === "saved" ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
