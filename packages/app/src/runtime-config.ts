import type { ConverseDeps } from "@bean/core";

export interface RuntimeConfigDeps {
  makeConverse: (apiKey: string, reasoningEffort: string) => ConverseDeps["chat"];
  saveConfigFile: (update: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string; delegateCli: string; systemControls: boolean; reasoningEffort: string; routineDigestContext: boolean; disabledClis: string[]; webSearch: boolean; autoMemory: boolean }) => Promise<void>;
}

export interface RuntimeConfig {
  converse: ConverseDeps["chat"];
  getModel: () => string;
  getApiKey: () => string;
  getTerminalApp: () => string;
  getEditorApp: () => string;
  getDelegateCli: () => string;
  getSystemControls: () => boolean;
  getReasoningEffort: () => string;
  getRoutineDigestContext: () => boolean;
  getDisabledClis: () => string[];
  getWebSearch: () => boolean;
  getAutoMemory: () => boolean;
  apply: (update: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string; delegateCli: string; systemControls: boolean; reasoningEffort: string; routineDigestContext: boolean; disabledClis: string[]; webSearch: boolean; autoMemory: boolean }) => Promise<void>;
}

// Holds the live OpenAI clients + model behind stable wrapper functions. IPC handlers close
// over the wrappers once at startup; apply() swaps the underlying clients in place so a Settings
// save takes effect on the next chat with no restart (see the Settings window).
export function createRuntimeConfig(
  initial: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string; delegateCli: string; systemControls: boolean; reasoningEffort: string; routineDigestContext: boolean; disabledClis: string[]; webSearch: boolean; autoMemory: boolean },
  deps: RuntimeConfigDeps,
): RuntimeConfig {
  let apiKey = initial.openaiApiKey;
  let model = initial.model;
  let terminalApp = initial.terminalApp;
  let editorApp = initial.editorApp;
  let delegateCli = initial.delegateCli;
  let systemControls = initial.systemControls;
  let reasoningEffort = initial.reasoningEffort;
  let routineDigestContext = initial.routineDigestContext;
  let disabledClis = initial.disabledClis;
  let webSearch = initial.webSearch;
  let autoMemory = initial.autoMemory;
  // ponytail: the OpenAI SDK throws in its constructor when apiKey is "", so building the
  // clients eagerly would crash startup before the user ever gets to Settings. Build lazily
  // per-call instead; a missing key just surfaces as an auth error from the actual chat call.
  let converseClient = apiKey ? deps.makeConverse(apiKey, reasoningEffort) : null;

  return {
    converse: ((...args: Parameters<ConverseDeps["chat"]>) => {
      if (!converseClient) throw new Error("No OpenAI API key configured — add one in Settings.");
      return converseClient(...args);
    }) as ConverseDeps["chat"],
    getModel: () => model,
    getApiKey: () => apiKey,
    getTerminalApp: () => terminalApp,
    getEditorApp: () => editorApp,
    getDelegateCli: () => delegateCli,
    getSystemControls: () => systemControls,
    getReasoningEffort: () => reasoningEffort,
    getRoutineDigestContext: () => routineDigestContext,
    getDisabledClis: () => disabledClis,
    getWebSearch: () => webSearch,
    getAutoMemory: () => autoMemory,
    apply: async (update) => {
      const nextConverseClient = update.openaiApiKey ? deps.makeConverse(update.openaiApiKey, update.reasoningEffort) : null;
      await deps.saveConfigFile({
        openaiApiKey: update.openaiApiKey, model: update.model,
        terminalApp: update.terminalApp, editorApp: update.editorApp, delegateCli: update.delegateCli,
        systemControls: update.systemControls,
        reasoningEffort: update.reasoningEffort,
        routineDigestContext: update.routineDigestContext,
        disabledClis: update.disabledClis,
        webSearch: update.webSearch,
        autoMemory: update.autoMemory,
      });
      apiKey = update.openaiApiKey;
      model = update.model;
      terminalApp = update.terminalApp;
      editorApp = update.editorApp;
      delegateCli = update.delegateCli;
      systemControls = update.systemControls;
      reasoningEffort = update.reasoningEffort;
      routineDigestContext = update.routineDigestContext;
      disabledClis = update.disabledClis;
      webSearch = update.webSearch;
      autoMemory = update.autoMemory;
      converseClient = nextConverseClient;
    },
  };
}
