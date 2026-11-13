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
  paths: { config: string; skills: string; projects: string; persona: string };
}
export interface ConfigUpdate {
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
