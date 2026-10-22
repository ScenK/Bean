import { CHATOPS_COMMANDS, type BotEffects, type IncomingMessage } from "@bean/core";
import { ApplicationCommandOptionType, type ApplicationCommandDataResolvable } from "discord.js";
import { chunkText } from "./chunk.js";

// The one option each kind of command carries; always required.
const OPTIONS = {
  user: { type: ApplicationCommandOptionType.User, name: "user", description: "Who" },
  name: { type: ApplicationCommandOptionType.String, name: "name", description: "Routine name" },
  prompt: { type: ApplicationCommandOptionType.String, name: "prompt", description: "What the agent should start on (editable before you Start)" },
} as const;

/** Discord's `/` picker: every core CHATOPS_COMMANDS entry, in DMs too (core refuses there). */
export function slashCommands(): ApplicationCommandDataResolvable[] {
  return CHATOPS_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    dmPermission: true,
    ...(c.option ? { options: [{ ...OPTIONS[c.option], required: true }] } : {}),
  }));
}

export interface SlashInvocation {
  commandName: string;
  user: { id: string; name: string };
  /** The `user` option, when the command has one. */
  target?: { id: string; name: string; bot: boolean };
  /** The `name` / `prompt` option, when the command has one. */
  arg?: string;
  conversationId: string;
  scopeId: string | undefined;
  direct: boolean;
  channelName: string | undefined;
}

/** The slash pick as the same message a typed command would be, so core's onCommand answers it. */
export function slashMessage(s: SlashInvocation): IncomingMessage {
  // Bots are never admins: dropped like messageCreate drops them from @mentions.
  const mentions = s.target && !s.target.bot ? [{ id: s.target.id, name: s.target.name }] : [];
  return {
    conversationId: s.conversationId,
    text: s.arg ? `${s.commandName} ${s.arg}` : s.commandName,
    fromId: s.user.id,
    fromName: s.user.name,
    scopeId: s.scopeId,
    direct: s.direct,
    channelName: s.channelName,
    mentions,
    mentionedIds: mentions.map((m) => m.id),
  };
}

export interface SlashOutput {
  /** The deferred ephemeral reply. */
  editReply: (text: string) => Promise<unknown>;
  /** Another ephemeral message, for a reply past Discord's 2000 chars. */
  followUp: (text: string) => Promise<unknown>;
  /** A public post in the channel (an admin change). */
  announce: (text: string) => Promise<unknown>;
}

/** Runs one command with `reply` collected into the ephemeral answer and `announce` posted
 * publicly. Always completes the interaction, even when the command said nothing. */
export async function answerSlash(
  run: (fx: Pick<BotEffects, "reply" | "announce">) => Promise<boolean>,
  out: SlashOutput,
): Promise<void> {
  const lines: string[] = [];
  let announced = false;
  const handled = await run({
    reply: async (text) => { lines.push(text); },
    announce: async (text) => {
      try {
        await out.announce(text);
        announced = true;
      } catch (err) {
        console.error("slash announce failed:", err);
        lines.push(`${text} (Couldn't post this in the channel.)`);
      }
    },
  });
  const text = lines.join("\n\n") || (!handled ? "Unknown command." : announced ? "Posted in the channel." : "OK.");
  const [first = text, ...rest] = chunkText(text);
  await out.editReply(first);
  for (const chunk of rest) await out.followUp(chunk);
}
