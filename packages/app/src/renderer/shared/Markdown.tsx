import { useMemo } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Real markdown (marked) sanitized with DOMPurify — model output is untrusted input to an
// Electron renderer, so raw HTML never lands in the DOM unsanitized.
export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })),
    [text],
  );
  return <div class="bean-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
