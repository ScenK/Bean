import { useMemo } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Real markdown (marked) sanitized with DOMPurify — model output is untrusted input to an
// Electron renderer, so raw HTML never lands in the DOM unsanitized.
export function Markdown({ text, onToggleTask }: { text: string; onToggleTask?: (index: number) => void }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })),
    [text],
  );
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
