import type { RepliedMessage } from "@bean/core";

/** The parts of a Teams message activity the quote parser reads. */
export interface QuoteActivity {
  text?: string;
  recipient: { id: string };
  entities?: { type?: string; [key: string]: unknown }[];
  attachments?: { contentType?: string; content?: unknown }[];
}

const MAX_CHARS = 2000;
const UNAVAILABLE: RepliedMessage = { fromName: "", byBean: false, text: "", at: 0, unavailable: true };
const QUOTED_PLACEHOLDER = /<quoted\b[^>]*\/>/gi;
const REPLY_BLOCKQUOTE = /<blockquote\b[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[^>]*>([\s\S]*?)<\/blockquote>/i;

/** Tags out, block breaks kept as newlines, the common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Capped; a preview ending in an ellipsis is Teams having cut a longer message. */
function capped(text: string): { text: string; truncated?: true } {
  if (text.length > MAX_CHARS) return { text: text.slice(0, MAX_CHARS), truncated: true };
  return /(…|\.\.\.)$/.test(text) ? { text, truncated: true } : { text };
}

/** Teams stamps bot ids as `28:<appId>`; a quote may carry either form. */
function isBean(senderId: string | undefined, botId: string): boolean {
  return !!senderId && (senderId === botId || senderId === botId.replace(/^28:/, ""));
}

/** Splits a Teams quote-reply into the sender's own words (`text`, mention-free input) and the
 * quoted message (`repliedTo`). Two shapes: the `quotedReply` entity Teams now sends (text carries
 * a `<quoted messageId="…"/>` placeholder; the quote is only a preview), and the legacy `text/html`
 * attachment whose `<blockquote itemtype="http://schema.skype.com/Reply">` holds the quote — there
 * `a.text` flattens the quote inline, so the sender's words come from the HTML outside it.
 * A quote it can't read gives `{ unavailable: true }`. Never throws. */
export function parseQuote(a: QuoteActivity, text: string): { text: string; repliedTo?: RepliedMessage } {
  const entity = (a.entities ?? []).find((e) => e.type === "quotedReply")?.quotedReply as
    | { senderId?: string; senderName?: string; preview?: string; time?: string; isReplyDeleted?: boolean }
    | undefined;
  if (entity) {
    const own = text.replace(QUOTED_PLACEHOLDER, "").trim();
    const preview = htmlToText(entity.preview ?? "");
    if (entity.isReplyDeleted || !preview) return { text: own, repliedTo: UNAVAILABLE };
    const c = capped(preview);
    return {
      text: own,
      repliedTo: {
        fromName: entity.senderName ?? "", byBean: isBean(entity.senderId, a.recipient.id),
        text: c.text, at: Number(entity.time) || 0, ...(c.truncated ? { truncated: true } : {}),
      },
    };
  }
  const html = a.attachments?.find((att) => att.contentType === "text/html" && typeof att.content === "string")
    ?.content as string | undefined;
  const quote = html?.match(REPLY_BLOCKQUOTE);
  if (!html || !quote) return { text };
  // Recipient mention entities carry their exact markup (`<at>Bean</at>`) — drop it like
  // removeRecipientMention does for `a.text`.
  let rest = html.replace(REPLY_BLOCKQUOTE, "");
  for (const e of a.entities ?? []) {
    const m = e as { type?: string; text?: string; mentioned?: { id?: string } };
    if (m.type === "mention" && m.mentioned?.id === a.recipient.id && m.text) rest = rest.split(m.text).join("");
  }
  const own = htmlToText(rest);
  const inner = quote[1] ?? "";
  const author = inner.match(/<[^>]*itemprop="mri"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  const authorId = author?.[0].match(/itemid="([^"]*)"/)?.[1];
  const time = inner.match(/itemprop="time"[^>]*itemid="(\d+)"/i)?.[1] ?? inner.match(/itemid="(\d+)"[^>]*itemprop="time"/i)?.[1];
  const preview = inner.match(/<[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const body = htmlToText(preview ?? "");
  if (!body) return { text: own, repliedTo: UNAVAILABLE };
  const c = capped(body);
  return {
    text: own,
    repliedTo: {
      fromName: htmlToText(author?.[1] ?? ""), byBean: isBean(authorId, a.recipient.id),
      text: c.text, at: Number(time) || 0, ...(c.truncated ? { truncated: true } : {}),
    },
  };
}
