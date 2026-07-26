import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TeamsConfig {
  botAppId: string;
  botAppPassword: string;
  /** Azure AD tenant ID for the bot's app registration. Required — Azure Bot Service
   * no longer offers the "Multi Tenant" app type in the portal for new registrations. */
  tenantId: string;
  port: number;
  /** Public HTTPS base of this bot server (the same tunnel/host Azure's messaging endpoint
   * points at, without the /api/messages path — e.g. "https://bean.example.ngrok.io").
   * Needed to deliver generated images: Teams rejects large inline base64 activities, so
   * images are served from this server and linked by URL. "" = image delivery disabled
   * (Bean posts the file path instead). */
  publicBaseUrl: string;
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
      `Teams config missing: ${file} — create it as ` +
        `{"botAppId": "...", "botAppPassword": "...", "tenantId": "..."} ` +
        "from your Azure Bot registration (see packages/teams/README.md).",
    );
  }
  let parsed: Partial<TeamsConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<TeamsConfig>;
  } catch {
    throw new Error(`Teams config invalid: ${file}`);
  }
  if (!parsed.botAppId || !parsed.botAppPassword || !parsed.tenantId) {
    throw new Error(`Teams config incomplete: ${file} needs botAppId, botAppPassword, and tenantId`);
  }
  return {
    botAppId: parsed.botAppId,
    botAppPassword: parsed.botAppPassword,
    tenantId: parsed.tenantId,
    port: parsed.port ?? 3978,
    publicBaseUrl: (parsed.publicBaseUrl ?? "").replace(/\/+$/, ""),
  };
}
