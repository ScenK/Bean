import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TeamsConfig {
  botAppId: string;
  botAppPassword: string;
  /** Azure AD tenant ID for the bot's app registration. Required — Azure Bot Service
   * no longer offers the "Multi Tenant" app type in the portal for new registrations. */
  tenantId: string;
  port: number;
  /** Optional dev-tunnel name. When set, the server logs in to devtunnel as the bot's own
   * service principal and hosts this tunnel for as long as it runs (see devtunnel.ts). */
  devtunnel?: string;
  /** The owner's Teams user id (`29:...`) or AAD object id: full powers (core chatops/roles.ts)
   * and the only target of outbox DMs. Unset = setup mode: everyone is a guest, DMs dropped. */
  ownerId?: string;
  /** How refusals name the owner ("Only Scen can …"). */
  ownerName?: string;
  /** Let non-owners DM Bean (as guests). Default false: they get one fixed line. */
  allowGuestDms: boolean;
}

type DmRef = {
  conversation?: { conversationType?: string };
  user?: { id?: string; aadObjectId?: string };
  bot?: { id?: string; isTargeted?: unknown }; // `id` too: a lone optional prop is a weak type ChannelAccount fails
};

/** Outbox DM targets: the owner's personal conversations only — never a coworker's who once
 * DMed the bot. No owner configured = no targets. A slash-picker pick in a group chat arrives
 * as a "personal" conversation too (`bot.isTargeted`), but posts there land in that group chat:
 * not a DM, so excluded. */
export function ownerDmRefs<R extends DmRef>(refs: Record<string, R>, ownerId: string | undefined): R[] {
  if (!ownerId) return [];
  return Object.values(refs).filter((r) =>
    r.conversation?.conversationType === "personal" && r.bot?.isTargeted !== true &&
    (r.user?.id === ownerId || r.user?.aadObjectId === ownerId));
}

type Delivered = { channel?: string; context?: boolean; displayBody?: string; body: string };

/** Where one delivered outbox message is saved as chat history: a key + body, `"missing-id"`
 * when it should be saved but can't be, or null for no save. A post to a bare channel id starts
 * a new thread, whose replies arrive as `<channel>;messageid=<post id>` — so it is always saved
 * under that thread key (never the bare id, which no reply ever uses), whatever `msg.context`
 * says. The saved body is model-facing (`body` when a `displayBody` was shown instead).
 * ponytail: one history row per digest post and no retention sweep; add one if bean.db size matters. */
export function deliveredAppend(
  msg: Delivered,
  conversation: { id: string; conversationType?: string },
  postedText: string,
  postedId: string | undefined,
): { key: string; body: string } | "missing-id" | null {
  if (conversation.conversationType === "channel" && !conversation.id.includes(";")) {
    if (!postedId) return "missing-id";
    return { key: `${conversation.id};messageid=${postedId}`, body: msg.displayBody ? msg.body : postedText };
  }
  if (msg.context) return { key: conversation.id, body: msg.body };
  if (msg.displayBody && msg.channel) return { key: msg.channel, body: msg.body };
  return null;
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
    ...(parsed.devtunnel ? { devtunnel: parsed.devtunnel } : {}),
    ...(typeof parsed.ownerId === "string" && parsed.ownerId ? { ownerId: parsed.ownerId } : {}),
    ...(typeof parsed.ownerName === "string" && parsed.ownerName ? { ownerName: parsed.ownerName } : {}),
    allowGuestDms: parsed.allowGuestDms === true,
  };
}
