import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DiscordConfig {
  botToken: string;
  /** Discord user ids allowed to talk to Bean and confirm runs. Everyone else is silently ignored. */
  allowedUserIds: string[];
}

export function discordConfigFile(dir: string): string {
  return join(dir, "discord.json");
}

export async function loadDiscordConfig(file: string): Promise<DiscordConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Discord config missing: ${file} — create it as {"botToken": "...", "allowedUserIds": ["<your discord user id>"]} ` +
        "(see packages/discord/README.md).",
    );
  }
  let parsed: Partial<DiscordConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<DiscordConfig>;
  } catch {
    throw new Error(`Discord config invalid: ${file}`);
  }
  const ids = Array.isArray(parsed.allowedUserIds) ? parsed.allowedUserIds.filter((x) => typeof x === "string" && x) : [];
  if (!parsed.botToken || ids.length === 0) {
    throw new Error(`Discord config incomplete: ${file} needs botToken and a non-empty allowedUserIds`);
  }
  return { botToken: parsed.botToken, allowedUserIds: ids };
}
