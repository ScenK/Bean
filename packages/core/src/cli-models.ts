import { readFile } from "node:fs/promises";
import type { CliName } from "./launcher.js";

/** Which models each provider (CLI) offers — loaded from clis.json, not hardcoded.
 * A model string is passed verbatim as the CLI's --model value; there is no canonical
 * id or alias layer (see the 2026-07-17 config-driven-cli-models spec). */
export interface CliModels {
  provider: CliName;
  models: string[];
}

const KNOWN_PROVIDERS: readonly CliName[] = ["opencode", "claude"];

// Degrades per entry, never throws: a bad file yields undefined (caller falls back),
// a bad entry is skipped with a log line — same spirit as the skills/projects loaders.
function parseCliModels(raw: string, source: string): CliModels[] | undefined {
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
  const out: CliModels[] = [];
  for (const entry of data) {
    const e = entry as { provider?: unknown; models?: unknown } | null;
    const provider = e?.provider;
    if (typeof provider !== "string" || !KNOWN_PROVIDERS.includes(provider as CliName)) {
      console.error(`bean: ${source}: unknown provider ${JSON.stringify(provider)} — skipped (adding a new CLI needs code)`);
      continue;
    }
    const models = Array.isArray(e?.models)
      ? e.models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    out.push({ provider: provider as CliName, models });
  }
  return out;
}

/** Repo defaults overlaid by the user file, merged per provider: a user entry for a
 * provider replaces that provider's default model list entirely; providers absent from
 * the user file keep their defaults. Missing/invalid user file → defaults only;
 * missing/invalid default file → []. */
export async function loadCliModels(defaultFile: string, userFile: string): Promise<CliModels[]> {
  const read = async (file: string): Promise<CliModels[] | undefined> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    return parseCliModels(raw, file);
  };
  const merged = [...((await read(defaultFile)) ?? [])];
  for (const entry of (await read(userFile)) ?? []) {
    const i = merged.findIndex((d) => d.provider === entry.provider);
    if (i === -1) merged.push(entry);
    else merged[i] = entry;
  }
  return merged;
}
