import type { CliName } from "./launcher.js";
import type { CliModels } from "./cli-models.js";

/** A model id is the literal --model flag string from clis.json (e.g. "sonnet",
 * "github-copilot/gpt-5.5") — launchCommand/delegateCommand pass it verbatim. `label` is
 * derived (last `/` segment); `availableOn` lists the detected CLIs whose config offers it
 * (empty = shown dimmed in the picker). */
export type AvailableModel = { id: string; label: string; availableOn: CliName[] };

function modelLabel(id: string): string {
  const seg = id.split("/").pop();
  return seg !== undefined && seg.trim() !== "" ? seg : id;
}

/** Every configured model annotated with which of the detected CLIs offers it — drives
 * the model picker's dimmed/reason-captioned rows. Undetected providers' models are kept
 * (dimmed) so the picker shows what would be available if that CLI were installed. */
export function availableModels(cliModels: CliModels[], detected: CliName[]): AvailableModel[] {
  const out: AvailableModel[] = [];
  for (const entry of cliModels) {
    for (const id of entry.models) {
      const offered = detected.includes(entry.provider);
      const existing = out.find((m) => m.id === id);
      if (existing) {
        if (offered && !existing.availableOn.includes(entry.provider)) existing.availableOn.push(entry.provider);
      } else {
        out.push({ id, label: modelLabel(id), availableOn: offered ? [entry.provider] : [] });
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
  return models.find((m) => m.availableOn.includes(cli))?.id ?? models[0]?.id;
}
