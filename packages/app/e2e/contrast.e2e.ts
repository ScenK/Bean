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
  // Walk to the first opaque background, keeping every translucent layer (and the opacity each
  // one inherits) on the way, then composite bottom-up — a 22%-white veil over an accent fill is
  // not the same backdrop as the fill itself, and a half-faded button is not its own color.
  const backdrop = (el) => {
    const layers = [];
    let fade = 1;
    let n = el;
    let base = null;
    while (n) {
      const cs = getComputedStyle(n);
      fade *= Number(cs.opacity === "" ? 1 : cs.opacity);
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) {
        const layer = [c[0], c[1], c[2], c[3] * fade];
        if (layer[3] >= 0.999) { base = layer; break; }
        layers.push(layer);
      }
      n = n.parentElement;
    }
    let out = base || [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return out;
  };
  const fade = (el) => { let f = 1, n = el; while (n) { const o = getComputedStyle(n).opacity; f *= Number(o === "" ? 1 : o); n = n.parentElement; } return f; };
  const fails = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    // WCAG exempts inactive controls, which is the whole point of the dimmed disabled state.
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    const raw = parse(cs.color);
    if (!raw) continue;
    const fg = [raw[0], raw[1], raw[2], raw[3] * fade(el)];
    const px = parseFloat(cs.fontSize);
    const need = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
    const got = ratio(fg, backdrop(el));
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
