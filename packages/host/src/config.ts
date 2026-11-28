import type { Proactivity } from "@bean/core";

/** Settings' view of `config.json` (+ the paths it shows). */
export interface ConfigView {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
  systemControls: boolean;
  disabledClis: string[];
  webSearch: boolean;
  autoMemory: boolean;
  homeDiscordDm: boolean;
  homeTeamsDm: boolean;
  gitName: string;
  gitEmail: string;
  /** The dial as the owner set it (#1158). */
  proactivity: Proactivity;
  /** Auto-backoff is holding the pulse below the dial (#1157): the level it runs at and since when
   * (ISO). Read-only; any dial change from Settings ends it. */
  proactivityLowered?: { to: Proactivity; at: string };
  /** Whether a key is saved — a remote shell gets `openaiApiKey: ""` (#812), never the key itself. */
  apiKeySet: boolean;
  paths: { config: string; skills: string; projects: string; persona: string };
}
/** Every field Settings can change. */
export interface ConfigFields {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
  systemControls: boolean;
  disabledClis: string[];
  webSearch: boolean;
  autoMemory: boolean;
  homeDiscordDm: boolean;
  homeTeamsDm: boolean;
  gitName: string;
  gitEmail: string;
  proactivity: Proactivity;
}
/** A Settings save is a patch (#812): an omitted field — the API key above all — keeps its value. */
export type ConfigUpdate = Partial<ConfigFields>;

export interface ConfigHandlerDeps {
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
  onApplied?: () => void;
}

export function buildConfigHandlers(deps: ConfigHandlerDeps) {
  return {
    get: (): ConfigView => deps.getConfig(),
    save: async (update: ConfigUpdate): Promise<void> => {
      await deps.applyConfig(update);
      deps.onApplied?.();
    },
  };
}
