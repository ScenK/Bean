import { unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { CLI_NAMES, type CliName } from "./launcher.js";

/** Which models each provider (CLI) offers — loaded from clis.json, not hardcoded.
 * A model string is passed verbatim as the CLI's --model value; there is no canonical
 * id or alias layer (see the 2026-07-17 config-driven-cli-models spec). */
export interface CliModels {
  provider: CliName;
  models: string[];
}

const KNOWN_PROVIDERS: readonly CliName[] = CLI_NAMES;

/** One clis.json entry as written. `models` sets the list outright; `add`/`hide` adjust the
 * list beneath (a user file's base is the repo default), so a user's tweaks keep receiving the
 * models a Bean update ships. */
interface CliModelsEntry {
  provider: CliName;
  models?: string[];
  add?: string[];
  hide?: string[];
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && m.trim() !== "") : undefined;

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
    const models = strings(e?.models);
    const add = strings(e?.add);
    const hide = strings(e?.hide);
    out.push({
      provider: provider as CliName,
      ...(models ? { models } : {}), ...(add ? { add } : {}), ...(hide ? { hide } : {}),
    });
  }
  return out;
}

/** `entry` applied over `base`: `models` (if set) replaces the base, then `hide` removes and
 * `add` appends (deduplicated). */
function applyEntry(base: readonly string[], entry: CliModelsEntry): string[] {
  const hide = new Set(entry.hide ?? []);
  const kept = (entry.models ?? base).filter((m) => !hide.has(m));
  for (const m of entry.add ?? []) if (!kept.includes(m)) kept.push(m);
  return kept;
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
  const merged: CliModels[] = ((await read(defaultFile)) ?? []).map((e) => ({ provider: e.provider, models: applyEntry([], e) }));
  for (const entry of (await read(userFile)) ?? []) {
    const i = merged.findIndex((d) => d.provider === entry.provider);
    const models = applyEntry(merged[i]?.models ?? [], entry);
    if (i === -1) merged.push({ provider: entry.provider, models });
    else merged[i] = { provider: entry.provider, models };
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

/** The one membership rule for a picked model: `cli`'s clis.json list offers it verbatim. A
 * dash-led value is never offered — it would read as a flag after `--model`. */
export function cliOffersModel(cliModels: readonly CliModels[], cli: CliName, model: string): boolean {
  return !model.startsWith("-") && (cliModels.find((e) => e.provider === cli)?.models ?? []).includes(model);
}
