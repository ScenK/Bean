import type { CliName } from "./launcher.js";
import type { CliModelDetails, CliModels } from "./cli-models.js";

/** Effort metadata for one model on one CLI, carried to renderers on `AvailableModel`. */
export type ModelEffortInfo = CliModelDetails;

/** A model id is the literal --model flag string from clis.json (e.g. "sonnet",
 * "github-copilot/gpt-5.5"), or the base id when `effortsByCli[cli].effortIds` maps each effort
 * to a provider-specific wire id (e.g. agy's "gemini-4-neon" → "gemini-4-neon-high"). `label` is
 * derived (last `/` segment, or the full id when that segment is shared with another
 * returned model, so pickers can tell providers apart); `availableOn` lists the enabled CLIs whose config offers it
 * (never empty — availableModels drops models no enabled CLI can run). */
export type AvailableModel = {
  id: string;
  label: string;
  availableOn: CliName[];
  effortsByCli?: Partial<Record<CliName, ModelEffortInfo>>;
};
export type CliModelSelection = { cli: CliName; model?: string; effort?: string };

function modelLabel(id: string): string {
  const seg = id.split("/").pop();
  return seg !== undefined && seg.trim() !== "" ? seg : id;
}

/** Display label for a reasoning effort level: lowercase, like the model ids it sits beside. */
export function effortLabel(effort: string): string {
  return effort.toLowerCase();
}

/** Efforts a sprout chat step offers for Bean's own (OpenAI) model when its model declares none. */
export const BEAN_EFFORTS: readonly string[] = ["none", "low", "medium", "high", "xhigh"];

/** Efforts Bean's own model offers: its declared efforts in clis.json, else BEAN_EFFORTS. */
export function beanEfforts(models: readonly AvailableModel[], modelId: string | undefined): readonly string[] {
  const hit = modelId ? matchAvailableModel(models, modelId) : undefined;
  return (hit ? hit.model.effortsByCli?.[hit.cli]?.efforts : undefined) ?? BEAN_EFFORTS;
}

/** Compact label for tight segmented buttons (`"medium"` → `"med"`, `"minimal"` → `"min"`). */
export function shortEffortLabel(effort: string): string {
  const e = effort.toLowerCase();
  return e === "medium" ? "med" : e === "minimal" ? "min" : e;
}

/** Every model offered by an enabled (detected and not Settings-disabled) CLI, annotated with
 * which of them offers it and each CLI's effort options. Models only an undetected/disabled
 * provider lists are omitted entirely, not dimmed — disabling a CLI in Settings removes its
 * models from every picker. */
export function availableModels(cliModels: CliModels[], detected: CliName[]): AvailableModel[] {
  const out: AvailableModel[] = [];
  for (const entry of cliModels) {
    if (!detected.includes(entry.provider)) continue;
    for (const id of entry.models) {
      const details = entry.modelDetails?.[id];
      const existing = out.find((m) => m.id === id);
      if (existing) {
        if (!existing.availableOn.includes(entry.provider)) existing.availableOn.push(entry.provider);
        if (details) {
          existing.effortsByCli = { ...existing.effortsByCli, [entry.provider]: details };
        }
      } else {
        out.push({
          id,
          label: modelLabel(id),
          availableOn: [entry.provider],
          ...(details ? { effortsByCli: { [entry.provider]: details } } : {}),
        });
      }
    }
  }
  // Two ids with the same last segment (openai/x vs github-copilot/x) would read identically.
  for (const m of out) {
    if (out.some((o) => o !== m && modelLabel(o.id) === modelLabel(m.id))) m.label = m.id;
  }
  return out;
}

/** Matches a model id (or legacy `effortIds` value like `"gemini-4-neon-high"`) in `models`,
 * optionally constrained to a specific `cli`. */
export function matchAvailableModel(
  models: readonly AvailableModel[],
  id: string | undefined,
  cli?: CliName,
): { model: AvailableModel; cli: CliName; impliedEffort?: string } | undefined {
  if (!id) return undefined;
  const direct = models.find((m) => m.id === id && (!cli || m.availableOn.includes(cli)));
  if (direct) {
    const resolvedCli = cli ?? direct.availableOn[0];
    if (resolvedCli) return { model: direct, cli: resolvedCli };
  }
  for (const m of models) {
    if (!m.effortsByCli) continue;
    const candidates = cli ? [cli] : m.availableOn;
    for (const c of candidates) {
      const effortIds = m.effortsByCli[c]?.effortIds;
      if (!effortIds) continue;
      for (const [effort, wireId] of Object.entries(effortIds)) {
        if (wireId === id) return { model: m, cli: c, impliedEffort: effort };
      }
    }
  }
  return undefined;
}

/** Effort options for `(cli, modelId)` (also recognizing legacy `effortIds` values). */
export function modelEfforts(
  models: readonly AvailableModel[],
  cli: CliName,
  modelId: string | undefined,
): ModelEffortInfo | undefined {
  const hit = matchAvailableModel(models, modelId, cli);
  return hit?.model.effortsByCli?.[cli];
}

/** Normalizes a possibly legacy `effortIds` value (e.g. `"gemini-4-neon-high"`) into its UI
 * `{ model, effort }` pair. Unknown models return `{}`. */
export function normalizeModelSelection(
  models: readonly AvailableModel[],
  cli: CliName,
  modelId: string | undefined,
  effort?: string,
): { model?: string; effort?: string } {
  const hit = matchAvailableModel(models, modelId, cli);
  if (!hit) return {};
  const info = hit.model.effortsByCli?.[cli];
  if (!info || info.efforts.length === 0) return { model: hit.model.id };
  const picked = (effort && info.efforts.includes(effort) ? effort : undefined)
    ?? hit.impliedEffort;
  return { model: hit.model.id, ...(picked ? { effort: picked } : {}) };
}

/** Picks a valid effort for `(cli, modelId)`: explicit `choice` → remembered `lastUsed` →
 * implied effort (from a legacy `effortIds` id) → `defaultEffort` → first offered effort.
 * Returns `undefined` when the model declares no effort options. */
export function pickEffort(
  models: readonly AvailableModel[],
  cli: CliName,
  modelId: string | undefined,
  choice?: string,
  lastUsed?: string,
): string | undefined {
  const hit = matchAvailableModel(models, modelId, cli);
  const info = hit?.model.effortsByCli?.[cli];
  if (!info || info.efforts.length === 0) return undefined;
  for (const candidate of [choice, lastUsed, hit?.impliedEffort, info.defaultEffort, info.efforts[0]]) {
    if (candidate && info.efforts.includes(candidate)) return candidate;
  }
  return undefined;
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
  const resolve = (id: string | undefined): string | undefined => {
    const hit = matchAvailableModel(models, id, cli);
    // Keep matched legacy effortIds aliases verbatim so string-only callers (ChatOps
    // resolveCliModel, IPC launch) preserve implied effort when calling resolveWireModel.
    return hit ? (hit.impliedEffort ? id : hit.model.id) : undefined;
  };
  return resolve(choice) ?? resolve(lastUsed) ?? models.find((m) => m.availableOn.includes(cli))?.id;
}

/** Resolve one compatible CLI/model pair for desktop proposals, delegates, and routines.
 * An explicit/remembered model chooses an enabled CLI that actually offers it. Otherwise an
 * enabled CLI preference wins and gets its first supported model; with no preference, the
 * first model offered by any enabled CLI is the default. A CLI whose config has no models is
 * still valid and intentionally returns without `model`, letting that CLI use its own default. */
export function resolveCliModelSelection(
  models: AvailableModel[],
  clis: CliName[],
  preferred: { cli?: CliName; model?: string; lastUsed?: string; effort?: string } = {},
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
    const preferredHit = preferred.cli && enabled.has(preferred.cli)
      ? matchAvailableModel(models, id, preferred.cli)
      : undefined;
    const hit = preferredHit ?? matchAvailableModel(models, id);
    if (!hit) continue;
    const cli = preferredHit ? preferredHit.cli : supportedCli(hit.model);
    if (cli && enabled.has(cli)) {
      const info = hit.model.effortsByCli?.[cli];
      const eff = (preferred.effort && info?.efforts.includes(preferred.effort) ? preferred.effort : undefined)
        ?? hit.impliedEffort;
      return { cli, model: hit.model.id, ...(eff ? { effort: eff } : {}) };
    }
  }

  if (preferred.cli && enabled.has(preferred.cli)) {
    const model = pickModel(models, preferred.cli);
    const info = model ? modelEfforts(models, preferred.cli, model) : undefined;
    const eff = preferred.effort && info?.efforts.includes(preferred.effort) ? preferred.effort : undefined;
    return { cli: preferred.cli, ...(model ? { model } : {}), ...(eff ? { effort: eff } : {}) };
  }

  const model = models.find((candidate) => candidate.availableOn.some((cli) => enabled.has(cli)));
  const cli = supportedCli(model) ?? clis[0];
  if (!cli) return undefined;
  const info = model ? modelEfforts(models, cli, model.id) : undefined;
  const eff = preferred.effort && info?.efforts.includes(preferred.effort) ? preferred.effort : undefined;
  return { cli, ...(model ? { model: model.id } : {}), ...(eff ? { effort: eff } : {}) };
}

/** Why a step's explicit harness/model/effort can't run on this Mac, or undefined if it can.
 * `clis`/`models` are the enabled CLIs and their models (availableModels). Shared by the
 * Routines panel's inline warning and the routine runner's refuse-before-spawn check. */
export function stepAvailabilityProblem(
  step: { cli?: CliName; model?: string; effort?: string },
  clis: CliName[],
  models: AvailableModel[],
): string | undefined {
  if (step.cli && !clis.includes(step.cli)) return `${step.cli} is not enabled`;
  if (step.model) {
    const hit = matchAvailableModel(models, step.model, step.cli);
    if (!hit) {
      return step.cli
        ? `${step.cli} doesn't offer model "${step.model}" here`
        : `model "${step.model}" isn't offered by any enabled coding agent`;
    }
    if (step.effort) {
      const info = hit.model.effortsByCli?.[hit.cli];
      if (!info?.efforts.includes(step.effort)) {
        return `${hit.cli} doesn't offer effort "${step.effort}" on "${hit.model.label}"`;
      }
    }
  }
  return undefined;
}

/** The pinned selection for a step with an explicit `cli`: refuses (throws) rather than
 * falling back, so an unattended run never silently swaps harness. */
export function pinnedStepSelection(
  step: { cli: CliName; model?: string; effort?: string },
  clis: CliName[],
  models: AvailableModel[],
): CliModelSelection {
  const problem = stepAvailabilityProblem(step, clis, models);
  if (problem) throw new Error(problem);
  const hit = step.model ? matchAvailableModel(models, step.model, step.cli) : undefined;
  const model = hit?.model.id ?? pickModel(models, step.cli);
  const info = model ? modelEfforts(models, step.cli, model) : undefined;
  const eff = (step.effort && info?.efforts.includes(step.effort) ? step.effort : undefined)
    ?? hit?.impliedEffort;
  return { cli: step.cli, ...(model ? { model } : {}), ...(eff ? { effort: eff } : {}) };
}

/** Resolve the Settings delegate preference together with an optional explicit model pick.
 * Auto (or a now-disabled saved preference) means the first enabled CLI; only an explicit
 * model request may move the selection to another compatible enabled provider. */
export function resolveDelegateSelection(
  cliModels: CliModels[],
  enabled: CliName[],
  configuredCli: string,
  explicitModel?: string,
  explicitEffort?: string,
): CliModelSelection | undefined {
  const preferredCli = enabled.includes(configuredCli as CliName)
    ? configuredCli as CliName
    : enabled[0];
  return resolveCliModelSelection(availableModels(cliModels, enabled), enabled, {
    ...(preferredCli ? { cli: preferredCli } : {}),
    ...(explicitModel ? { model: explicitModel } : {}),
    ...(explicitEffort ? { effort: explicitEffort } : {}),
  });
}
