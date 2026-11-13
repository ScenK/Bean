/** Settings' view of `config.json` (+ the paths it shows). */
export interface ConfigView {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
  systemControls: boolean;
  reasoningEffort: string;
  routineDigestContext: boolean;
  disabledClis: string[];
  webSearch: boolean;
  autoMemory: boolean;
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
  reasoningEffort: string;
  routineDigestContext: boolean;
  disabledClis: string[];
  webSearch: boolean;
  autoMemory: boolean;
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
