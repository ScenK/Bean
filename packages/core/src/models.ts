import type { CliName } from "./launcher.js";

/** A canonical model name shown to the user; `aliases` maps to whatever flag value each
 * CLI actually expects. A CLI absent from `aliases` means that model can't be requested
 * on that CLI at all (its picker row shows dimmed with a reason). */
export interface ModelInfo {
  id: string;
  label: string;
  aliases: Partial<Record<CliName, string>>;
}

export const MODELS: ModelInfo[] = [
  { id: "sonnet-4-5", label: "Sonnet 4.5", aliases: { opencode: "claude-sonnet-4-5", claude: "sonnet-4-5" } },
  { id: "opus-4-5", label: "Opus 4.5", aliases: { opencode: "claude-opus-4-5", claude: "opus-4-5" } },
  { id: "gpt-5-mini", label: "GPT-5 mini", aliases: { opencode: "gpt-5-mini" } },
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
