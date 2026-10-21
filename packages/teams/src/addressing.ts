/** The parts of a Teams message activity the addressing gate reads. */
export interface AddressActivity {
  conversation: { conversationType?: string };
  recipient: { id: string; isTargeted?: unknown };
  entities?: { type?: string; [key: string]: unknown }[];
}

/** True when the message is for Bean: a personal (1:1) chat, an @mention of the bot, or a
 * targeted message (a pick from Teams' `/` command picker — `recipient.isTargeted`, no mention
 * entity) whose recipient is the bot itself. Naming the bot in passing ("we should add x to
 * bean") deliberately does NOT count — that message is about Bean, not to it, and becomes
 * ambient context instead. Only call this on activities the CloudAdapter authenticated.
 * Addressing grants a turn, never a permission: `direct`, scope and roles are decided elsewhere.
 * `botId` is the bot's Teams id, `28:<app id>`. */
export function addressedToBot(a: AddressActivity, botId: string): boolean {
  if (a.conversation.conversationType === "personal") return true;
  // botbuilder's ChannelAccount has no isTargeted yet; strict boolean, never a truthy string.
  if (a.recipient.isTargeted === true && a.recipient.id === botId) return true;
  return (a.entities ?? []).some(
    (e) => e.type === "mention" && (e as { mentioned?: { id?: string } }).mentioned?.id === a.recipient.id,
  );
}
