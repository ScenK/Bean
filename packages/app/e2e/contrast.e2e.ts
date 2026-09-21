import { test, expect } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// Walks every rendered text node in every component window, in both themes, and computes the
// real WCAG contrast against the nearest opaque ancestor background. Colors are resolved
// through a canvas because getComputedStyle hands back `oklch(...)` verbatim in Chromium.
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
  const backdrop = (el) => { let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0.5) return c; n = n.parentElement; } return [255, 255, 255, 1]; };
  const fails = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const px = parseFloat(cs.fontSize);
    const need = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
    const got = ratio(fg, backdrop(el));
    if (got < need) fails.push(\`\${el.className || el.tagName} "\${(el.textContent || "").trim().slice(0, 30)}" \${got.toFixed(2)}:1 < \${need}:1\`);
  }
  return fails;
})()`;

const WINDOWS = ["chat", "skills", "projects", "routines", "settings", "persona", "about", "notes"];

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
