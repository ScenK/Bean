import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// Walks every rendered text node in every component window, in both themes, and computes the
// real WCAG contrast against the composited backdrop. Colors are resolved through a canvas
// because getComputedStyle hands back `oklch(...)` verbatim in Chromium.
// Covers the default render of each window only: hover, selection and error states are not
// exercised here, so token-level coverage lives in __test__/theme-contrast.test.ts.
const SCAN = `(() => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const parse = (s) => {
    if (!s || s === "transparent" || s === "none") return null;
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = s;
    if (cx.fillStyle === "#000" && !/^#0{3,8}$|black|rgba?\\(0, ?0, ?0/.test(s)) return null;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = (c) => { const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0] / 255) + 0.7152 * f(c[1] / 255) + 0.0722 * f(c[2] / 255); };
  const over = (f, b) => (f[3] >= 1 ? f : [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat([1]));
  const ratio = (f, b) => { const x = lum(over(f, b)), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // CSS opacity fades an element *and its descendants* as a group over what is behind it, so a
  // layer's effective alpha carries its own opacity and its ancestors' — never its children's.
  // Collect the chain once, then apply the suffix product of opacities to each layer.
  const chain = (el) => {
    const rows = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      rows.push({ alpha: Number(cs.opacity === "" ? 1 : cs.opacity), bg: parse(cs.backgroundColor) });
    }
    let fade = 1;
    for (let i = rows.length - 1; i >= 0; i--) { fade *= rows[i].alpha; rows[i].fade = fade; }
    return rows;
  };
  // The backdrop behind the text: every background above it, composited bottom-up.
  const backdrop = (rows) => {
    const layers = [];
    let base = null;
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i].bg;
      if (!c || c[3] === 0) continue;
      const layer = [c[0], c[1], c[2], c[3] * rows[i].fade];
      if (layer[3] >= 0.999) { base = layer; break; }
      layers.push(layer);
    }
    let out = base || [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return out;
  };
  const fails = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    // WCAG exempts inactive controls, which is the whole point of the dimmed disabled state.
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    const raw = parse(cs.color);
    if (!raw) continue;
    const rows = chain(el);
    // The element's own background sits between its text and everything above it.
    const own = rows[0].bg;
    let bg = backdrop(rows);
    if (own && own[3] > 0) bg = over([own[0], own[1], own[2], own[3] * rows[0].fade], bg);
    const fg = [raw[0], raw[1], raw[2], raw[3] * rows[0].fade];
    const px = parseFloat(cs.fontSize);
    const need = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) fails.push(\`\${el.className || el.tagName} "\${(el.textContent || "").trim().slice(0, 30)}" \${got.toFixed(2)}:1 < \${need}:1\`);
  }
  return fails;
})()`;

const WINDOWS = ["chat", "skills", "projects", "routines", "settings", "persona", "about", "notes", "plan"];

test("every component window clears WCAG AA text contrast in both themes", async () => {
  const home = await makeBeanHome();
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    for (const kind of WINDOWS) {
      const [win] = await Promise.all([
        app.waitForEvent("window"),
        avatar.evaluate((k) => (window as unknown as { bean: { openComponent: (kind: string) => void } }).bean.openComponent(k), kind),
      ]);
      await win.waitForLoadState("domcontentloaded");
      await win.waitForTimeout(600);
      for (const theme of ["hearth", "graphite"]) {
        await win.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(await win.evaluate(SCAN), `${kind} / ${theme}`).toEqual([]);
      }
      await win.close();
    }
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
