import type { CliName } from "./launcher.js";

/** A canonical model name shown to the user; `aliases` maps to whatever flag value each
 * CLI actually expects. A CLI absent from `aliases` means that model can't be requested
 * on that CLI at all (its picker row shows dimmed with a reason). Each model here is
 * available on exactly one CLI — claude code and opencode (via the github-copilot
 * provider) don't offer the same underlying models, so there's no shared "same model,
 * different flag spelling" pairing to make across CLIs like there used to be. */
export interface ModelInfo {
  id: string;
  label: string;
  aliases: Partial<Record<CliName, string>>;
}

export const MODELS: ModelInfo[] = [
  { id: "sonnet", label: "Sonnet", aliases: { claude: "sonnet" } },
  { id: "opus", label: "Opus", aliases: { claude: "opus" } },
  { id: "haiku", label: "Haiku", aliases: { claude: "haiku" } },
  { id: "gpt-5-5", label: "GPT-5.5", aliases: { opencode: "github-copilot/gpt-5.5" } },
  { id: "gpt-5-4", label: "GPT-5.4", aliases: { opencode: "github-copilot/gpt-5.4" } },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: { opencode: "github-copilot/claude-sonnet-5" } },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", aliases: { opencode: "github-copilot/claude-opus-4.8" } },
];

/** The CLI-specific flag value for a canonical model, or undefined if that model has no
 * alias on this CLI (launchCommand/delegateCommand skip the --model flag in that case). */
export function resolveModelAlias(modelId: string, cli: CliName): string | undefined {
  return MODELS.find((m) => m.id === modelId)?.aliases[cli];
}

export type AvailableModel = ModelInfo & { availableOn: CliName[] };

/** MODELS annotated with which of the detected CLIs actually support each — drives the
 * model picker's dimmed/reason-captioned rows. */
export function availableModels(clis: CliName[]): AvailableModel[] {
  return MODELS.map((m) => ({
    ...m,
    availableOn: clis.filter((cli) => m.aliases[cli] !== undefined),
  }));
}

/** The model the proposal will actually launch with, given an explicit user pick, the
 * last-used model, and the current CLI. Keeps the picked/remembered model only while the
 * current CLI supports it — otherwise falls back to a CLI-supported model, so switching CLI
 * can never launch a model the CLI silently ignores (would drop --model and run its default). */
export function pickModel(
  models: AvailableModel[],
  cli: CliName,
  choice?: string,
  lastUsed?: string,
): string | undefined {
  const supportsCli = (id: string | undefined): boolean =>
    id !== undefined && models.some((m) => m.id === id && m.aliases[cli] !== undefined);
  const remembered = lastUsed !== undefined && models.some((m) => m.id === lastUsed) ? lastUsed : undefined;
  const preferred = choice ?? remembered;
  if (supportsCli(preferred)) return preferred;
  return models.find((m) => m.aliases[cli] !== undefined)?.id ?? models[0]?.id;
}
