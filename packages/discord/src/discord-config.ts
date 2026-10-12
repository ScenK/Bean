import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DiscordConfig {
  botToken: string;
  /** Optional: register slash commands to this one guild (appears instantly) instead of globally
   * (every guild Bean is in, but ~1h first propagation). Handy for dev/single-server setups. */
  guildId?: string;
  /** The owner's Discord user id: full powers (see core chatops/roles.ts), and the only target of
   * outbox DMs (routine digests with no channel, interrupted-run notices). */
  ownerId: string;
  /** How refusals name the owner ("Only Scen can …"). */
  ownerName?: string;
  /** Let non-owners DM Bean (as guests). Default false: they get one fixed line. */
  allowGuestDms: boolean;
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
      `Discord config missing: ${file} — create it as {"botToken": "...", "ownerId": "<your discord user id>"} ` +
        "(see packages/discord/README.md).",
    );
  }
  let parsed: Partial<DiscordConfig> & { allowedUserIds?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`Discord config invalid: ${file}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Discord config invalid: ${file}`);
  }
  if (!parsed.botToken) throw new Error(`Discord config incomplete: ${file} needs botToken`);
  // Pre-roles configs had only an allow-list: a single entry is unambiguously the owner.
  // Several (or none) can't be guessed — Discord ids are easy to copy, so ask for ownerId.
  const legacy = Array.isArray(parsed.allowedUserIds)
    ? parsed.allowedUserIds.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  const ownerId = typeof parsed.ownerId === "string" && parsed.ownerId
    ? parsed.ownerId
    : legacy.length === 1 ? legacy[0] : undefined;
  if (!ownerId) {
    throw new Error(`Discord config incomplete: ${file} needs ownerId (your Discord user id) — allowedUserIds is replaced by owner/admin roles`);
  }
  const guildId = typeof parsed.guildId === "string" && parsed.guildId ? parsed.guildId : undefined;
  const ownerName = typeof parsed.ownerName === "string" && parsed.ownerName ? parsed.ownerName : undefined;
  return {
    botToken: parsed.botToken, ownerId, allowGuestDms: parsed.allowGuestDms === true,
    ...(guildId ? { guildId } : {}), ...(ownerName ? { ownerName } : {}),
  };
}
