import type { CliName } from "./launcher.js";
import type { CliModels } from "./cli-models.js";

/** A model id is the literal --model flag string from clis.json (e.g. "sonnet",
 * "github-copilot/gpt-5.5") — launchCommand/delegateCommand pass it verbatim. `label` is
 * derived (last `/` segment); `availableOn` lists the enabled CLIs whose config offers it
 * (never empty — availableModels drops models no enabled CLI can run). */
export type AvailableModel = { id: string; label: string; availableOn: CliName[] };
export type CliModelSelection = { cli: CliName; model?: string };

function modelLabel(id: string): string {
  const seg = id.split("/").pop();
  return seg !== undefined && seg.trim() !== "" ? seg : id;
}

/** Every model offered by an enabled (detected and not Settings-disabled) CLI, annotated with
 * which of them offers it. Models only an undetected/disabled provider lists are omitted
 * entirely, not dimmed — disabling a CLI in Settings removes its models from every picker. */
export function availableModels(cliModels: CliModels[], detected: CliName[]): AvailableModel[] {
  const out: AvailableModel[] = [];
  for (const entry of cliModels) {
    if (!detected.includes(entry.provider)) continue;
    for (const id of entry.models) {
      const existing = out.find((m) => m.id === id);
      if (existing) {
        if (!existing.availableOn.includes(entry.provider)) existing.availableOn.push(entry.provider);
      } else {
        out.push({ id, label: modelLabel(id), availableOn: [entry.provider] });
      }
    }
  }
  return out;
}

/** The model the proposal will actually launch with, given an explicit user pick, the
 * last-used model, and the current CLI. Keeps the picked/remembered model only while the
 * current CLI supports it — otherwise falls back to a CLI-supported model, so switching CLI
 * can never launch a model the CLI silently ignores (would run its default). */
export function pickModel(
  models: AvailableModel[],
  cli: CliName,
  choice?: string,
  lastUsed?: string,
): string | undefined {
  const supportsCli = (id: string | undefined): boolean =>
    id !== undefined && models.some((m) => m.id === id && m.availableOn.includes(cli));
  const remembered = lastUsed !== undefined && models.some((m) => m.id === lastUsed) ? lastUsed : undefined;
  const preferred = choice ?? remembered;
  if (supportsCli(preferred)) return preferred;
  return models.find((m) => m.availableOn.includes(cli))?.id;
}

/** Resolve one compatible CLI/model pair for desktop proposals, delegates, and routines.
 * An explicit/remembered model chooses an enabled CLI that actually offers it. Otherwise an
 * enabled CLI preference wins and gets its first supported model; with no preference, the
 * first model offered by any enabled CLI is the default. A CLI whose config has no models is
 * still valid and intentionally returns without `model`, letting that CLI use its own default. */
export function resolveCliModelSelection(
  models: AvailableModel[],
  clis: CliName[],
  preferred: { cli?: CliName; model?: string; lastUsed?: string } = {},
): CliModelSelection | undefined {
  if (clis.length === 0) return undefined;

  const enabled = new Set(clis);
  const supportedCli = (model: AvailableModel | undefined): CliName | undefined => {
    if (!model) return undefined;
    if (preferred.cli && enabled.has(preferred.cli) && model.availableOn.includes(preferred.cli)) {
      return preferred.cli;
    }
    return clis.find((cli) => model.availableOn.includes(cli));
  };

  for (const id of [preferred.model, preferred.lastUsed]) {
    if (!id) continue;
    const model = models.find((candidate) => candidate.id === id);
    const cli = supportedCli(model);
    if (cli) return { cli, model: id };
  }

  if (preferred.cli && enabled.has(preferred.cli)) {
    const model = pickModel(models, preferred.cli);
    return { cli: preferred.cli, ...(model ? { model } : {}) };
  }

  const model = models.find((candidate) => candidate.availableOn.some((cli) => enabled.has(cli)));
  const cli = supportedCli(model) ?? clis[0];
  if (!cli) return undefined;
  return { cli, ...(model ? { model: model.id } : {}) };
}
