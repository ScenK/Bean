import { useEffect, useState } from "preact/hooks";
import type { CliName } from "@bean/core";
import type { ConfigUpdate, ConfigView } from "../../../channels.js";
import type { Theme } from "../../../channels.js";
import type { ChatopsBot, ChatopsState } from "@bean/host";
import { PanelHeader } from "../../shared/Panel.js";
import { DestinationsList } from "./DestinationsList.js";
import { useCapabilities } from "../../shared/capabilities.js";
import { useCoreStatus } from "../../shared/core-status.js";

type SaveState = "idle" | "saving" | "saved" | "error";

// "" is deliberately first: models without reasoning reject the parameter outright, so the
// default must send nothing at all rather than any effort value.
const REASONING_EFFORTS = ["", "none", "low", "medium", "high"] as const;

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
  { id: "destinations", label: "Destinations" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Data" },
];

// The Azure Bot messaging endpoint for a self-hosted Teams tunnel — the bot is the only place
// this URL exists, so it has to be readable (and copyable) here.
function EndpointRow({ endpoint }: { endpoint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(endpoint).then(() => setCopied(true), () => {});
  };
  return (
    <div class="bean-settings-row" title="Paste into Azure Bot → Configuration → Messaging endpoint">
      <span class="bean-chatops-label">Messaging endpoint: {endpoint}</span>
      <button type="button" class="bean-btn bean-btn--ghost" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function SettingsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [apiKey, setApiKey] = useState("");
  // Sent only once edited (#812): a save is a patch, and a remote core never sends its key here.
  const [apiKeyEdited, setApiKeyEdited] = useState(false);
  const [apiKeySet, setApiKeySet] = useState(false);
  const caps = useCapabilities();
  const handoff = caps.has("terminalHandoff");
  // System controls drive the core's machine: offered only when that machine is a Mac.
  const macCore = caps.platform === "darwin";
  const [model, setModel] = useState("");
  const [terminalApp, setTerminalApp] = useState("");
  const [editorApp, setEditorApp] = useState("");
  const [delegateCli, setDelegateCli] = useState("");
  const [systemControls, setSystemControls] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [routineDigestContext, setRoutineDigestContext] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [autoMemory, setAutoMemory] = useState(true);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [detectedClis, setDetectedClis] = useState<CliName[]>([]);
  const [disabledClis, setDisabledClis] = useState<string[]>([]);
  const [paths, setPaths] = useState<ConfigView["paths"] | undefined>(undefined);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [activeSection, setActiveSection] = useState("model");
  const [chatops, setChatops] = useState<Record<ChatopsBot, ChatopsState>>({
    discord: { running: false, enabled: false },
    teams: { running: false, enabled: false },
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

  // Save stays off until the config loaded (#812): a remote core that was reconnecting when this window
  // opened would otherwise get the form's blanks saved over its model and settings. Retried on reattach.
  const [loaded, setLoaded] = useState(false);
  const core = useCoreStatus();
  const coreState = core.kind === "remote" ? core.state : core.kind;
  useEffect(() => {
    if (loaded) return;
    let live = true;
    window.bean.detectedClis().then((d) => { if (live) setDetectedClis(d); }, () => {});
    window.bean.getConfig().then((c: ConfigView) => {
      if (!live) return;
      setApiKey(c.openaiApiKey);
      setApiKeySet(c.apiKeySet);
      setModel(c.model);
      setTerminalApp(c.terminalApp);
      setEditorApp(c.editorApp);
      setDelegateCli(c.delegateCli);
      setSystemControls(c.systemControls);
      setReasoningEffort(c.reasoningEffort);
      setRoutineDigestContext(c.routineDigestContext);
      setWebSearch(c.webSearch);
      setAutoMemory(c.autoMemory);
      // An older remote core has no identity fields.
      setGitName(c.gitName ?? "");
      setGitEmail(c.gitEmail ?? "");
      setDisabledClis(c.disabledClis);
      setPaths(c.paths);
      setLoaded(true);
    }, () => {});
    return () => { live = false; };
  }, [coreState]);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.chatopsStatus().then((status) => {
      setChatops(status);
      (Object.keys(status) as ChatopsBot[]).forEach((bot) => { if (status[bot].error) scheduleErrorClear(bot, status[bot].error!); });
    });
    window.bean.onChatopsEvent((e) => {
      setChatops((prev) => ({ ...prev, [e.bot]: { running: e.running, enabled: e.enabled, error: e.error, endpoint: e.endpoint } }));
      if (e.error) scheduleErrorClear(e.bot, e.error);
    });
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const onSave = async (): Promise<void> => {
    if (!loaded) return;
    setSave("saving");
    setError(undefined);
    try {
      // Only what this window shows: a hidden field (and an untouched key) keeps its saved value.
      const patch: ConfigUpdate = {
        model: model.trim(), delegateCli, reasoningEffort, routineDigestContext, disabledClis, webSearch, autoMemory,
        gitName: gitName.trim(), gitEmail: gitEmail.trim(),
        ...(apiKeyEdited ? { openaiApiKey: apiKey.trim() } : {}),
        ...(handoff ? { terminalApp: terminalApp.trim(), editorApp: editorApp.trim() } : {}),
        ...(macCore ? { systemControls } : {}),
      };
      await window.bean.saveConfig(patch);
      if (apiKeyEdited) { setApiKeySet(apiKey.trim() !== ""); setApiKeyEdited(false); }
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
  const enabledClis = detectedClis.filter((c) => !disabledClis.includes(c));

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
                placeholder={apiKeySet && !apiKey ? `Saved on ${caps.host ?? "the core"} — type to replace` : "sk-…"}
                onInput={(e) => { setApiKey((e.target as HTMLInputElement).value); setApiKeyEdited(true); setSave("idle"); }}
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
            <span class="bean-settings-row-label">Reasoning effort</span>
            <div class="bean-settings-row-control">
              <select
                class="bean-input"
                title="Only reasoning models accept this. Others reject the request — leave it on Default for gpt-4o-mini or gpt-5.4-nano."
                value={reasoningEffort}
                onChange={(e) => { setReasoningEffort((e.target as HTMLSelectElement).value); setSave("idle"); }}
              >
                {REASONING_EFFORTS.map((e) => (
                  <option key={e} value={e}>{e === "" ? "Default (model's own)" : e}</option>
                ))}
              </select>
            </div>
          </div>
          {detectedClis.length > 0 && (
            <div class="bean-settings-row">
              <span class="bean-settings-row-label">CLIs</span>
              <div class="bean-settings-row-control">
                {detectedClis.map((c) => (
                  <label key={c} class="bean-chatops-row" title="Unchecked CLIs disappear from every launch and delegate picker.">
                    <input
                      type="checkbox"
                      checked={!disabledClis.includes(c)}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        setDisabledClis((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]));
                        setSave("idle");
                      }}
                    />
                    <span class="bean-chatops-label">{c}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Delegate CLI</span>
            <div class="bean-settings-row-control">
              <select
                class="bean-input"
                value={delegateCli}
                onChange={(e) => { setDelegateCli((e.target as HTMLSelectElement).value); setSave("idle"); }}
              >
                <option value="">Auto (first enabled{enabledClis[0] ? `: ${enabledClis[0]}` : ""})</option>
                {enabledClis.map((c) => <option key={c} value={c}>{c}</option>)}
                {/* A saved CLI that's undetected or unchecked still shows, so the select never claims "Auto" over it. */}
                {delegateCli && !(enabledClis as string[]).includes(delegateCli) && (
                  <option value={delegateCli} disabled>{delegateCli} (not available, using Auto)</option>
                )}
              </select>
            </div>
          </div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Commit as</span>
            <div class="bean-settings-row-control" title="Author, committer and Co-Authored-By trailer of commits made by Bean's delegates and live sessions. Takes effect on the next run.">
              <input
                class="bean-input"
                type="text"
                value={gitName}
                placeholder="Bean"
                onInput={(e) => { setGitName((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
              <input
                class="bean-input"
                type="email"
                value={gitEmail}
                placeholder="bean@localhost"
                onInput={(e) => { setGitEmail((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
            </div>
          </div>
        </section>

        <section id="apps" class="bean-settings-card">
          <div class="bean-settings-card-header">APPS</div>
          {handoff ? <div class="bean-settings-row">
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
          </div> : null}
          {macCore ? <div class="bean-settings-row">
            <span class="bean-settings-row-label">System controls</span>
            <div class="bean-settings-row-control">
              <label class="bean-chatops-row" title={`Lets Bean's chat set volume, control music, and launch/quit apps on ${caps.host ?? "this Mac"} via a fixed set of macOS commands.`}>
                <input
                  type="checkbox"
                  checked={systemControls}
                  onChange={(e) => { setSystemControls((e.target as HTMLInputElement).checked); setSave("idle"); }}
                />
                <span class="bean-chatops-label">Allow volume / media / app control {caps.host ? `on ${caps.host} ` : ""}from chat</span>
              </label>
            </div>
          </div> : null}
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Web search</span>
            <div class="bean-settings-row-control">
              <label class="bean-chatops-row" title="Lets Bean's chat (desktop, Discord, Teams) search the public web for news, docs, and releases. Your own repos, tickets, and mail still go to a delegated agent. Each search is billed by OpenAI.">
                <input
                  type="checkbox"
                  checked={webSearch}
                  onChange={(e) => { setWebSearch((e.target as HTMLInputElement).checked); setSave("idle"); }}
                />
                <span class="bean-chatops-label">Allow public web search from chat</span>
              </label>
            </div>
          </div>
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Memory</span>
            <div class="bean-settings-row-control">
              <label class="bean-chatops-row" title="When a desktop chat closes, Bean saves durable facts you told it (undo them in Persona) and periodically tidies its memory. Off: Bean only remembers or forgets when you ask.">
                <input
                  type="checkbox"
                  checked={autoMemory}
                  onChange={(e) => { setAutoMemory((e.target as HTMLInputElement).checked); setSave("idle"); }}
                />
                <span class="bean-chatops-label">Remember things automatically</span>
              </label>
            </div>
          </div>
          {handoff ? <div class="bean-settings-row">
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
          </div> : null}
        </section>

        <section id="chatbots" class="bean-settings-card">
          <div class="bean-settings-card-header">
            <span>CHAT BOTS</span>
            <span>{runningCount} of {CHATOPS_BOTS.length} running</span>
          </div>
          {CHATOPS_BOTS.map(({ key, label }) => {
            const s = chatops[key];
            const dotClass = s.running ? "bean-chatops-dot--running" : s.error ? "bean-chatops-dot--error" : "";
            return [
              <div key={key} class="bean-settings-row" title={s.error}>
                <span class="bean-chatops-row">
                  <span class={`bean-chatops-dot ${dotClass}`} />
                  <span class={`bean-chatops-label ${s.error ? "bean-chatops-label-error" : ""}`}>
                    {label}{s.running ? " — running" : s.error ? ` — ${s.error}` : " — stopped"}
                  </span>
                </span>
                {/* Follows `enabled`, not `running`: while a crashed bot is retrying (or has given
                    up) it's still switched on, and Stop is the only way to clear that intent so it
                    doesn't autostart again next launch. */}
                <button
                  type="button"
                  class="bean-btn bean-btn--ghost"
                  onClick={() => (s.enabled ? window.bean.chatopsStop(key) : window.bean.chatopsStart(key))}
                >
                  {s.enabled ? "Stop" : "Start"}
                </button>
              </div>,
              s.running && s.endpoint ? <EndpointRow key={`${key}-endpoint`} endpoint={s.endpoint} /> : null,
            ];
          })}
          <div class="bean-settings-row">
            <span class="bean-settings-row-label">Sprout digests</span>
            <div class="bean-settings-row-control">
              <label class="bean-chatops-row" title="Keeps each sprout digest in the conversation it was posted to, so you can ask follow-up questions about it. Off by default — digests nobody asks about still cost tokens on every later turn. Teams channel digests are always kept in their own post's thread, so replies there can follow up either way.">
                <input
                  type="checkbox"
                  checked={routineDigestContext}
                  onChange={(e) => { setRoutineDigestContext((e.target as HTMLInputElement).checked); setSave("idle"); }}
                />
                <span class="bean-chatops-label">Keep digests as chat context for follow-ups</span>
              </label>
            </div>
          </div>
        </section>

        <section id="destinations" class="bean-settings-card">
          <div class="bean-settings-card-header">DESTINATIONS</div>
          <DestinationsList />
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
            <span>{caps.host ? `~/.bean on ${caps.host}` : "~/.bean"}</span>
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
          <button type="button" class="bean-btn" disabled={!loaded || save === "saving"} onClick={() => void onSave()}>
            {!loaded ? "Loading…" : save === "saving" ? "Saving…" : save === "saved" ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
