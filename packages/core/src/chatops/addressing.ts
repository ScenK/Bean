/** True when the text names the bot by name ("bean, look at this"), so channel
 * messages can address it without a platform @-mention. Word-boundary,
 * case-insensitive. */
export function mentionsBotName(text: string, botName: string): boolean {
  const name = botName.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}
