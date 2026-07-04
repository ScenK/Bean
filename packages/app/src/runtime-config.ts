import type { RouterDeps, ConverseDeps } from "@bean/core";

export interface RuntimeConfigDeps {
  makeChat: (apiKey: string) => RouterDeps["chat"];
  makeConverse: (apiKey: string) => ConverseDeps["chat"];
  saveConfigFile: (update: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string }) => Promise<void>;
}

export interface RuntimeConfig {
  chat: RouterDeps["chat"];
  converse: ConverseDeps["chat"];
  getModel: () => string;
  getApiKey: () => string;
  getTerminalApp: () => string;
  getEditorApp: () => string;
  apply: (update: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string }) => Promise<void>;
}

// Holds the live OpenAI clients + model behind stable wrapper functions. IPC handlers close
// over the wrappers once at startup; apply() swaps the underlying clients in place so a Settings
// save takes effect on the next chat/route with no restart (see the Settings window).
export function createRuntimeConfig(
  initial: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string },
  deps: RuntimeConfigDeps,
): RuntimeConfig {
  let apiKey = initial.openaiApiKey;
  let model = initial.model;
  let terminalApp = initial.terminalApp;
  let editorApp = initial.editorApp;
  // ponytail: the OpenAI SDK throws in its constructor when apiKey is "", so building the
  // clients eagerly would crash startup before the user ever gets to Settings. Build lazily
  // per-call instead; a missing key just surfaces as an auth error from the actual chat call.
  let chatClient = apiKey ? deps.makeChat(apiKey) : null;
  let converseClient = apiKey ? deps.makeConverse(apiKey) : null;

  return {
    chat: ((...args: Parameters<RouterDeps["chat"]>) => {
      if (!chatClient) throw new Error("No OpenAI API key configured — add one in Settings.");
      return chatClient(...args);
    }) as RouterDeps["chat"],
    converse: ((...args: Parameters<ConverseDeps["chat"]>) => {
      if (!converseClient) throw new Error("No OpenAI API key configured — add one in Settings.");
      return converseClient(...args);
    }) as ConverseDeps["chat"],
    getModel: () => model,
    getApiKey: () => apiKey,
    getTerminalApp: () => terminalApp,
    getEditorApp: () => editorApp,
    apply: async (update) => {
      const nextChatClient = update.openaiApiKey ? deps.makeChat(update.openaiApiKey) : null;
      const nextConverseClient = update.openaiApiKey ? deps.makeConverse(update.openaiApiKey) : null;
      await deps.saveConfigFile({
        openaiApiKey: update.openaiApiKey, model: update.model,
        terminalApp: update.terminalApp, editorApp: update.editorApp,
      });
      apiKey = update.openaiApiKey;
      model = update.model;
      terminalApp = update.terminalApp;
      editorApp = update.editorApp;
      chatClient = nextChatClient;
      converseClient = nextConverseClient;
    },
  };
}
