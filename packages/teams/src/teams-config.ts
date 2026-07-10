import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TeamsConfig {
  botAppId: string;
  botAppPassword: string;
  port: number;
}

export function teamsConfigFile(dir: string): string {
  return join(dir, "teams.json");
}

export async function loadTeamsConfig(file: string): Promise<TeamsConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Teams config missing: ${file} — create it as {"botAppId": "...", "botAppPassword": "..."} ` +
        "from your Azure Bot registration (see packages/teams/README.md).",
    );
  }
  let parsed: Partial<TeamsConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<TeamsConfig>;
  } catch {
    throw new Error(`Teams config invalid: ${file}`);
  }
  if (!parsed.botAppId || !parsed.botAppPassword) {
    throw new Error(`Teams config incomplete: ${file} needs botAppId and botAppPassword`);
  }
  return { botAppId: parsed.botAppId, botAppPassword: parsed.botAppPassword, port: parsed.port ?? 3978 };
}
