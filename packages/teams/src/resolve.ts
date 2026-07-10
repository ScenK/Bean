import { availableModels, pickModel, type CliName } from "@bean/core";

export interface CliModelChoice {
  cli: CliName;
  model?: string;
}

const CLI_KEY = "teams:cli";
const modelKey = (cli: CliName): string => `teams:model:${cli}`;

/** Spec's three-layer resolution: chat-stated → last-used (model memory) → first detected.
 * pickModel guards the cli/model cross-product (a model the cli can't run falls back). */
export function resolveCliModel(
  detected: CliName[],
  stated: { cli?: CliName; model?: string },
  memory: Record<string, string>,
): CliModelChoice | undefined {
  const remembered = memory[CLI_KEY] as CliName | undefined;
  const cli =
    stated.cli && detected.includes(stated.cli) ? stated.cli
    : remembered && detected.includes(remembered) ? remembered
    : detected[0];
  if (cli === undefined) return undefined;
  const model = pickModel(availableModels(detected), cli, stated.model, memory[modelKey(cli)]);
  return { cli, model };
}

/** The model-memory entries a confirmed run should persist. */
export function memoryUpdatesFor(choice: CliModelChoice): Record<string, string> {
  return { [CLI_KEY]: choice.cli, ...(choice.model ? { [modelKey(choice.cli)]: choice.model } : {}) };
}
