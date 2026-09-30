import { useMemo } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Only images Bean itself resolved into an inline raster data: URL may render. Any other
// <img> (remote http(s), local path) would be fetched just by displaying it — a tracking /
// exfiltration beacon a fetched page or search result can plant via model output (#183).
// It becomes its alt text plus, for http(s), a plain link the user can open on purpose.
const INLINE_IMAGE = /^data:image\/(png|jpeg|webp)[;,]/i;
// isSupported is false only without a DOM (node-env tests importing ChatWindow); every renderer has one.
if (DOMPurify.isSupported) DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "IMG") {
    // <video>/<audio>/<source>/<input type=image> fetch their src on display too.
    if (node instanceof Element) node.removeAttribute("src");
    return;
  }
  const img = node as HTMLImageElement;
  const src = img.getAttribute("src") ?? "";
  if (INLINE_IMAGE.test(src)) return;
  const label = img.getAttribute("alt") || src || "image";
  let replacement: Node = document.createTextNode(label);
  if (/^https?:\/\//i.test(src)) {
    const a = document.createElement("a");
    a.setAttribute("href", src);
    a.textContent = label;
    replacement = a;
  }
  img.replaceWith(replacement);
});

// Real markdown (marked) sanitized with DOMPurify — model output is untrusted input to an
// Electron renderer, so raw HTML never lands in the DOM unsanitized. The config closes the
// other auto-fetch channels besides <img src>: CSS url()s (style), srcset, video posters, and
// SVG <image>/<use> (html-only profile).
const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style"],
  FORBID_ATTR: ["style", "srcset", "sizes", "poster", "background"],
};
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), PURIFY);
}

export function Markdown({ text, onToggleTask }: { text: string; onToggleTask?: (index: number) => void }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const handleClick = onToggleTask
    ? (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" || (target as HTMLInputElement).type !== "checkbox") return;
        const boxes = Array.from((e.currentTarget as HTMLElement).querySelectorAll('input[type="checkbox"]'));
        onToggleTask(boxes.indexOf(target));
      }
    : undefined;
  return (
    <div
      class="bean-md"
      dangerouslySetInnerHTML={{ __html: onToggleTask ? html.replace(/ disabled(="")?/g, "") : html }}
      onClick={handleClick}
    />
  );
}
