import { expect, test } from "vitest";
import { extractPageText } from "../src/web-page.js";

test("strips tags, scripts, styles, and comments down to readable text", () => {
  const html = `<html><head><title>x</title><style>.a{}</style></head>
    <body><script>var a=1;</script><!-- hidden --><h1>Hello</h1><p>World &amp; you</p></body></html>`;
  expect(extractPageText(html)).toBe("Hello World & you");
});

test("decodes common entities", () => {
  expect(extractPageText("<p>a &lt;b&gt; &quot;c&quot; &#39;d&#39;&nbsp;e</p>")).toBe(`a <b> "c" 'd' e`);
});

test("truncates long pages and marks the cut", () => {
  const out = extractPageText(`<p>${"word ".repeat(100)}</p>`, 20);
  expect(out.length).toBeLessThan(40);
  expect(out).toContain("…[truncated]");
});
