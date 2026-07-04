// Pure, node-free HTML→text extraction so the fetch_url action tool (app/main) can hand
// readable page text to the model. ponytail: regex HTML stripping; swap in a real parser
// if pages come out garbled.

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function extractPageText(html: string, maxChars = 20_000): string {
  const text = html
    .replace(/<(script|style|head|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)} …[truncated]` : text;
}
