import { unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { CLI_NAMES, type CliName } from "./launcher.js";

/** Effort metadata for one configured model on a provider.
 * `effortIds` maps each effort level to a literal `--model` value for CLIs like `agy` whose
 * model IDs encode effort (e.g. `high` → `gemini-4-neon-high`). When present, those values are
 * also accepted as legacy aliases for existing sprouts, receipts, and model memory. */
export interface CliModelDetails {
  efforts: string[];
  defaultEffort?: string;
  effortIds?: Record<string, string>;
}

/** Which models each provider (CLI) offers — loaded from clis.json, not hardcoded.
 * A model string is passed verbatim as the CLI's --model value unless `modelDetails[id].effortIds`
 * maps `(id, effort)` to a provider-specific model ID. */
export interface CliModels {
  provider: CliName;
  models: string[];
  modelDetails?: Record<string, CliModelDetails>;
}

const KNOWN_PROVIDERS: readonly CliName[] = CLI_NAMES;
const EFFORT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** One parsed model item inside a clis.json entry: either a plain string or `{ id, efforts?, defaultEffort?, effortIds? }`. */
interface ParsedModel {
  id: string;
  details?: CliModelDetails;
}

/** One clis.json entry as written. `models` sets the list outright; `add`/`hide` adjust the
 * list beneath (a user file's base is the repo default), so a user's tweaks keep receiving the
 * models a Bean update ships. */
interface CliModelsEntry {
  provider: CliName;
  models?: ParsedModel[];
  add?: ParsedModel[];
  hide?: string[];
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && m.trim() !== "") : undefined;

const validEffort = (v: unknown): v is string => typeof v === "string" && EFFORT_RE.test(v);

function parseModelItem(raw: unknown): ParsedModel | undefined {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id } : undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as { id?: unknown; efforts?: unknown; defaultEffort?: unknown; effortIds?: unknown };
  if (typeof o.id !== "string" || !o.id.trim()) return undefined;
  const id = o.id.trim();
  const rawEfforts = Array.isArray(o.efforts)
    ? [...new Set(o.efforts.filter(validEffort))]
    : [];
  let effortIds: Record<string, string> | undefined;
  if (o.effortIds && typeof o.effortIds === "object" && !Array.isArray(o.effortIds)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.effortIds as Record<string, unknown>)) {
      if (validEffort(k) && typeof v === "string" && v.trim() !== "" && !v.startsWith("-")) {
        map[k] = v.trim();
      }
    }
    if (Object.keys(map).length > 0) effortIds = map;
  }
  const efforts = rawEfforts.length > 0
    ? rawEfforts
    : effortIds ? Object.keys(effortIds) : [];
  if (efforts.length === 0) return { id };
  const defaultEffort = validEffort(o.defaultEffort) && efforts.includes(o.defaultEffort)
    ? o.defaultEffort
    : undefined;
  return {
    id,
    details: {
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(effortIds ? { effortIds } : {}),
    },
  };
}

function parseModelList(v: unknown): ParsedModel[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((item) => {
    const p = parseModelItem(item);
    return p ? [p] : [];
  });
}

// Degrades per entry, never throws: a bad file yields undefined (caller falls back),
// a bad entry is skipped with a log line — same spirit as the skills/projects loaders.
function parseCliModels(raw: string, source: string): CliModelsEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`bean: ${source} is not valid JSON — ignoring it`);
    return undefined;
  }
  if (!Array.isArray(data)) {
    console.error(`bean: ${source} is not an array — ignoring it`);
    return undefined;
  }
  const out: CliModelsEntry[] = [];
  for (const entry of data) {
    const e = entry as { provider?: unknown; models?: unknown; add?: unknown; hide?: unknown } | null;
    const provider = e?.provider;
    if (typeof provider !== "string" || !KNOWN_PROVIDERS.includes(provider as CliName)) {
      console.error(`bean: ${source}: unknown provider ${JSON.stringify(provider)} — skipped (adding a new CLI needs code)`);
      continue;
    }
    const models = parseModelList(e?.models);
    const add = parseModelList(e?.add);
    const hide = strings(e?.hide);
    out.push({
      provider: provider as CliName,
      ...(models ? { models } : {}), ...(add ? { add } : {}), ...(hide ? { hide } : {}),
    });
  }
  return out;
}

/** `entry` applied over `base`: `models` (if set) replaces the base, then `hide` removes and
 * `add` appends (deduplicated; re-adding an existing id updates its effort metadata). */
function applyEntry(
  base: { models: readonly string[]; modelDetails?: Record<string, CliModelDetails> },
  entry: CliModelsEntry,
): { models: string[]; modelDetails?: Record<string, CliModelDetails> } {
  const hide = new Set(entry.hide ?? []);
  const details: Record<string, CliModelDetails> = {};
  const list: string[] = [];

  const push = (id: string, d?: CliModelDetails): void => {
    if (hide.has(id)) return;
    let resolvedDetails: CliModelDetails | undefined = d;
    if (d?.effortIds) {
      // Allow hiding an individual effortId (e.g. hiding "gemini-4-neon-low" drops that effort).
      const keptIds: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.effortIds)) {
        if (!hide.has(v)) keptIds[k] = v;
      }
      const keptEfforts = d.efforts.filter((k) => !d.effortIds?.[k] || keptIds[k] !== undefined);
      if (keptEfforts.length === 0) return;
      const defaultEffort = d.defaultEffort && keptEfforts.includes(d.defaultEffort) ? d.defaultEffort : undefined;
      resolvedDetails = {
        efforts: keptEfforts,
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(Object.keys(keptIds).length > 0 ? { effortIds: keptIds } : {}),
      };
    }
    if (!list.includes(id)) list.push(id);
    if (resolvedDetails) details[id] = resolvedDetails;
  };

  if (entry.models) {
    for (const m of entry.models) push(m.id, m.details);
  } else {
    for (const id of base.models) push(id, base.modelDetails?.[id]);
  }
  for (const m of entry.add ?? []) push(m.id, m.details);

  return {
    models: list,
    ...(Object.keys(details).length > 0 ? { modelDetails: details } : {}),
  };
}

/** Repo defaults overlaid by the user file, per provider: a user entry's `add`/`hide` adjust
 * that provider's default list, a user `models` replaces it; providers absent from the user
 * file keep their defaults. Missing/invalid user file → defaults only; missing/invalid default
 * file → []. */
export async function loadCliModels(defaultFile: string, userFile: string): Promise<CliModels[]> {
  const read = async (file: string): Promise<CliModelsEntry[] | undefined> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    return parseCliModels(raw, file);
  };
  const merged: CliModels[] = ((await read(defaultFile)) ?? []).map((e) => ({
    provider: e.provider,
    ...applyEntry({ models: [] }, e),
  }));
  for (const entry of (await read(userFile)) ?? []) {
    const i = merged.findIndex((d) => d.provider === entry.provider);
    const applied = applyEntry(merged[i] ?? { models: [] }, entry);
    if (i === -1) merged.push({ provider: entry.provider, ...applied });
    else merged[i] = { provider: entry.provider, ...applied };
  }
  return merged;
}

/** loadCliModels, kept live: the user file is stat-polled and, when it changes, the returned
 * array is refilled in place — every holder of it sees the new list without a restart. `reload`
 * re-reads now (a picker asking for the list mustn't wait out the poll). Only the user file is
 * watched; the repo default changes only with an update (= a restart). */
export async function watchCliModels(
  defaultFile: string, userFile: string, intervalMs = 2000,
): Promise<{ cliModels: CliModels[]; reload: () => Promise<void>; stop: () => void }> {
  const cliModels = await loadCliModels(defaultFile, userFile);
  let seq = 0;
  const reload = async (): Promise<void> => {
    const mine = ++seq;
    const fresh = await loadCliModels(defaultFile, userFile);
    if (mine === seq) cliModels.splice(0, cliModels.length, ...fresh); // a later reload wins
  };
  const onChange = (): void => { void reload(); };
  watchFile(userFile, { interval: intervalMs, persistent: false }, onChange);
  return { cliModels, reload, stop: () => unwatchFile(userFile, onChange) };
}

/** Resolves a model id (including legacy `effortIds` values like `"gemini-4-neon-high"`) to its
 * canonical entry in `cli`'s clis.json, plus the implied effort when matched via `effortIds`. */
export function findCliModel(
  cliModels: readonly CliModels[],
  cli: CliName,
  model: string,
): { id: string; details?: CliModelDetails; impliedEffort?: string } | undefined {
  if (!model || model.startsWith("-")) return undefined;
  const entry = cliModels.find((e) => e.provider === cli);
  if (!entry) return undefined;
  if (entry.models.includes(model)) {
    return { id: model, ...(entry.modelDetails?.[model] ? { details: entry.modelDetails[model] } : {}) };
  }
  if (entry.modelDetails) {
    for (const id of entry.models) {
      const details = entry.modelDetails[id];
      if (!details?.effortIds) continue;
      for (const [effort, wireId] of Object.entries(details.effortIds)) {
        if (wireId === model) return { id, details, impliedEffort: effort };
      }
    }
  }
  return undefined;
}

/** The one membership rule for a picked model: `cli`'s clis.json list offers it verbatim or as an
 * `effortIds` value (so legacy sprouts/receipts remain valid). A dash-led value is never offered —
 * it would read as a flag after `--model`. */
export function cliOffersModel(cliModels: readonly CliModels[], cli: CliName, model: string): boolean {
  return findCliModel(cliModels, cli, model) !== undefined;
}

/** Whether `effort` is an offered effort level for `(cli, model)` in clis.json. */
export function cliOffersEffort(
  cliModels: readonly CliModels[],
  cli: CliName,
  model: string,
  effort: string,
): boolean {
  if (!validEffort(effort)) return false;
  const found = findCliModel(cliModels, cli, model);
  return Boolean(found?.details?.efforts.includes(effort));
}

/** Translates a UI/config `(model, effort)` into the exact CLI wire arguments (`--model` +
 * optional `--effort` / `-c` / `--variant`).
 * - For `effortIds` models (e.g. `agy`'s `gemini-4-neon`): maps to the suffixed wire `--model`
 *   (using explicit `effort`, else `impliedEffort`, else `defaultEffort`, else `efforts[0]`) and
 *   omits a separate `effort` flag.
 * - For flag-based models (`claude`, `codex`, `opencode`): passes `model` verbatim and passes
 *   `effort` only when explicitly provided and offered by that model (so unattended sprouts with
 *   no `effort` keep their exact prior behavior). */
export function resolveWireModel(
  cliModels: readonly CliModels[],
  cli: CliName,
  model: string | undefined,
  effort?: string,
): { model?: string; effort?: string } {
  if (!model) return {};
  const found = findCliModel(cliModels, cli, model);
  if (!found) return { model, ...(effort && validEffort(effort) ? { effort } : {}) };
  const details = found.details;
  if (details?.effortIds) {
    const picked = (effort && details.efforts.includes(effort) ? effort : undefined)
      ?? found.impliedEffort
      ?? details.defaultEffort
      ?? details.efforts[0];
    const wireModel = (picked ? details.effortIds[picked] : undefined) ?? model;
    return { model: wireModel };
  }
  const picked = effort && details?.efforts.includes(effort) ? effort : undefined;
  return { model: found.id, ...(picked ? { effort: picked } : {}) };
}
