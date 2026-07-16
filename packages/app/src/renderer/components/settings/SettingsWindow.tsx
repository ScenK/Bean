import { useEffect, useState } from "preact/hooks";
import type { CliName } from "@bean/core";
import type { ConfigView } from "../../../channels.js";
import type { Theme } from "../../../channels.js";
import type { ChatopsBot, ChatopsState } from "../../../chatops-servers.js";
import { PanelHeader } from "../../shared/Panel.js";

type SaveState = "idle" | "saving" | "saved" | "error";

const PATH_LABELS: { key: keyof ConfigView["paths"]; label: string }[] = [
  { key: "config", label: "Config" },
  { key: "skills", label: "Skills" },
  { key: "projects", label: "Projects" },
  { key: "persona", label: "Persona" },
];

const CHATOPS_BOTS: { key: ChatopsBot; label: string }[] = [
  { key: "discord", label: "Discord" },
  { key: "teams", label: "Teams" },
];

const SECTIONS = [
  { id: "model", label: "Model" },
  { id: "apps", label: "Apps" },
  { id: "chatbots", label: "Chat bots" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Data" },
];

export function SettingsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [terminalApp, setTerminalApp] = useState("");
  const [editorApp, setEditorApp] = useState("");
  const [delegateCli, setDelegateCli] = useState("");
  const [systemControls, setSystemControls] = useState(false);
  const [clis, setClis] = useState<CliName[]>([]);
  const [paths, setPaths] = useState<ConfigView["paths"] | undefined>(undefined);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [activeSection, setActiveSection] = useState("model");
  const [chatops, setChatops] = useState<Record<ChatopsBot, ChatopsState>>({
    discord: { running: false },
    teams: { running: false },
  });

  // A chatops error (e.g. "not built") stays informative for a few seconds, then clears itself
  // so a stale row doesn't sit red forever — the underlying process state is already gone by then.
  // Guards on the exact error value so a fresher error that arrives before the timeout fires
  // isn't clobbered by a stale clear.
  const scheduleErrorClear = (bot: ChatopsBot, err: string): void => {
    setTimeout(() => {
      setChatops((prev) => (prev[bot].error === err ? { ...prev, [bot]: { ...prev[bot], error: undefined } } : prev));
    }, 3000);
  };

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.availableClis().then(setClis);
    window.bean.getConfig().then((c: ConfigView) => {
      setApiKey(c.openaiApiKey);
      setModel(c.model);
      setTerminalApp(c.terminalApp);
      setEditorApp(c.editorApp);
      setDelegateCli(c.delegateCli);
      setSystemControls(c.systemControls);
      setPaths(c.paths);
    });
    window.bean.chatopsStatus().then((status) => {
      setChatops(status);
      (Object.keys(status) as ChatopsBot[]).forEach((bot) => { if (status[bot].error) scheduleErrorClear(bot, status[bot].error!); });
    });
    window.bean.onChatopsEvent((e) => {
      setChatops((prev) => ({ ...prev, [e.bot]: { running: e.running, error: e.error } }));
      if (e.error) scheduleErrorClear(e.bot, e.error);
    });
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const onSave = async (): Promise<void> => {
    setSave("saving");
    setError(undefined);
    try {
      await window.bean.saveConfig({
        openaiApiKey: apiKey.trim(), model: model.trim(),
        terminalApp: terminalApp.trim(), editorApp: editorApp.trim(), delegateCli, systemControls,
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

  const jumpTo = (id: string): void => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const runningCount = CHATOPS_BOTS.filter(({ key }) => chatops[key].running).length;

  return (
    <div class="bean-dashboard">
      <div class="bean-settings-jumpbar">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            class={`bean-settings-tab ${activeSection === id ? "bean-settings-tab--active" : ""}`}
            onClick={() => jumpTo(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div class="bean-settings">
        <section id="model" class="bean-settings-card">
          <div class="bean-settings-card-header">MODEL</div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">OpenAI API key</span>
            <div class="bean-settings-row-control">
              <input
                class="bean-input bean-input--compact"
                type="password"
                value={apiKey}
                placeholder="sk-…"
                onInput={(e) => { setApiKey((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
            </div>
          </div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Model name</span>
            <div class="bean-settings-row-control">
              <input
                class="bean-input"
                type="text"
                value={model}
                placeholder="gpt-4o-mini"
                onInput={(e) => { setModel((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
            </div>
          </div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Delegate CLI</span>
            <div class="bean-settings-row-control">
              <select
                class="bean-input"
                value={delegateCli}
                onChange={(e) => { setDelegateCli((e.target as HTMLSelectElement).value); setSave("idle"); }}
              >
                <option value="">Auto (first detected{clis[0] ? `: ${clis[0]}` : ""})</option>
                {clis.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </section>

        <section id="apps" class="bean-settings-card">
          <div class="bean-settings-card-header">APPS</div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Terminal</span>
            <div class="bean-settings-row-control">
              <input
                class="bean-input"
                type="text"
                value={terminalApp}
                placeholder="System Default"
                onInput={(e) => { setTerminalApp((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browseTerminalApp()}>Browse…</button>
            </div>
          </div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">System controls</span>
            <div class="bean-settings-row-control">
              <label class="bean-chatops-row" title="Lets Bean's chat set volume, control music, and launch/quit apps via a fixed set of macOS commands.">
                <input
                  type="checkbox"
                  checked={systemControls}
                  onChange={(e) => { setSystemControls((e.target as HTMLInputElement).checked); setSave("idle"); }}
                />
                <span class="bean-chatops-label">Allow volume / media / app control from chat</span>
              </label>
            </div>
          </div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Editor</span>
            <div class="bean-settings-row-control">
              <input
                class="bean-input"
                type="text"
                value={editorApp}
                placeholder="Not set — required for Open in Editor"
                onInput={(e) => { setEditorApp((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browseEditorApp()}>Browse…</button>
            </div>
          </div>
        </section>

        <section id="chatbots" class="bean-settings-card">
          <div class="bean-settings-card-header">
            <span>CHAT BOTS</span>
            <span>{runningCount} of {CHATOPS_BOTS.length} running</span>
          </div>
          {CHATOPS_BOTS.map(({ key, label }) => {
            const s = chatops[key];
            const dotClass = s.running ? "bean-chatops-dot--running" : s.error ? "bean-chatops-dot--error" : "";
            return (
              <div key={key} class="bean-settings-row" title={s.error}>
                <span class="bean-chatops-row">
                  <span class={`bean-chatops-dot ${dotClass}`} />
                  <span class={`bean-chatops-label ${s.error ? "bean-chatops-label-error" : ""}`}>
                    {label}{s.running ? " — running" : s.error ? ` — ${s.error}` : " — stopped"}
                  </span>
                </span>
                <button
                  type="button"
                  class="bean-btn bean-btn--ghost"
                  onClick={() => (s.running ? window.bean.chatopsStop(key) : window.bean.chatopsStart(key))}
                >
                  {s.running ? "Stop" : "Start"}
                </button>
              </div>
            );
          })}
        </section>

        <section id="appearance" class="bean-settings-card">
          <div class="bean-settings-card-header">APPEARANCE</div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Theme</span>
            <div class="bean-settings-segment">
              <button
                type="button"
                class={`bean-settings-segment-btn ${theme === "hearth" ? "bean-settings-segment-btn--active" : ""}`}
                onClick={() => void window.bean.setTheme("hearth")}
              >
                Hearth
              </button>
              <button
                type="button"
                class={`bean-settings-segment-btn ${theme === "graphite" ? "bean-settings-segment-btn--active" : ""}`}
                onClick={() => void window.bean.setTheme("graphite")}
              >
                Graphite
              </button>
            </div>
          </div>
        </section>

        <section id="data" class="bean-settings-card">
          <div class="bean-settings-card-header">
            <span>DATA</span>
            <span>~/.bean</span>
          </div>
          <div class="bean-paths" style={{ padding: "10px 14px" }}>
            {paths
              ? PATH_LABELS.map(({ key, label }) => (
                  <div key={key} class="bean-path-row">
                    <span class="bean-path-label">{label}</span>
                    <span class="bean-path-value">{paths[key]}</span>
                  </div>
                ))
              : <div class="bean-path-row">Loading…</div>}
          </div>
        </section>
      </div>

      <div class="bean-settings-footer">
        {error ? <div class="bean-persona-error">Save failed: {error}</div> : <div />}
        <div class="bean-card-actions">
          <button type="button" class="bean-btn" disabled={save === "saving"} onClick={() => void onSave()}>
            {save === "saving" ? "Saving…" : save === "saved" ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
