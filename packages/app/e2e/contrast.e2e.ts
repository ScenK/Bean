import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { dbFile, saveDesktopChat } from "@bean/core";
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
  // Stack two translucent layers into one, keeping the combined alpha.
  const merge = (t, b) => {
    const a = t[3] + b[3] * (1 - t[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (t[i] * t[3] + b[i] * b[3] * (1 - t[3])) / a).concat([a]);
  };
  const ratio = (f, b) => { const x = lum(over(f, b)), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // CSS opacity fades an element *and its descendants* as one group, so the only correct model
  // is to composite inward-out: build the pixel inside the innermost group, then, at each step
  // outward, scale it by that group's opacity and lay it over the next ancestor's background.
  const scale = (c, k) => [c[0], c[1], c[2], c[3] * k];
  const chain = (el) => {
    const rows = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const bg = parse(cs.backgroundColor);
      rows.push({ alpha: Number(cs.opacity === "" ? 1 : cs.opacity), bg: bg && bg[3] > 0 ? bg : null });
    }
    return rows;
  };
  // The seed is the text color for the glyph pixel, or a transparent pixel for the backdrop it
  // sits on; both travel the same stack, which is what makes the two comparable.
  const fold = (rows, seed) => {
    let c = rows[0].bg ? merge(seed, rows[0].bg) : seed;
    for (let i = 1; i < rows.length; i++) {
      c = scale(c, rows[i - 1].alpha);
      if (rows[i].bg) c = merge(c, rows[i].bg);
    }
    return over(scale(c, rows[rows.length - 1].alpha), [255, 255, 255, 1]);
  };
  // Hearth keeps its original amber fill with white ink: 3.3:1, below AA and deliberate (see
  // .memory/convention-theme-contrast.md). Text painted in --bean-accent-ink is on that fill by
  // construction, so it is held to 3:1 — a regression past that still fails the run.
  const inkColor = parse(getComputedStyle(document.documentElement).getPropertyValue("--bean-accent-ink"));
  const sameColor = (a, b) => a && b && Math.abs(a[0] - b[0]) < 2 && Math.abs(a[1] - b[1]) < 2 && Math.abs(a[2] - b[2]) < 2;
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
    const fg = fold(rows, raw);
    const bg = fold(rows, [0, 0, 0, 0]);
    const px = parseFloat(cs.fontSize);
    let need = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
    if (sameColor(parse(cs.color), inkColor)) need = 3;
    const got = ratio(fg, bg);
    if (got < need) fails.push(\`\${el.className || el.tagName} "\${(el.textContent || "").trim().slice(0, 30)}" \${got.toFixed(2)}:1 < \${need}:1\`);
  }
  // Agent mascots are graphics (WCAG 1.4.11): the body fill holds 3:1 against what it sits on.
  for (const svg of document.querySelectorAll(".bean-agent-avatar")) {
    const body = svg.firstElementChild;
    const fill = body && parse(getComputedStyle(body).fill);
    if (!fill) { fails.push(\`\${svg.getAttribute("class")} has no resolvable fill\`); continue; }
    const rows = chain(svg.parentElement);
    const got = ratio(fold(rows, fill), fold(rows, [0, 0, 0, 0]));
    if (got < 3) fails.push(\`\${svg.getAttribute("class")} \${got.toFixed(2)}:1 < 3:1\`);
  }
  return fails;
})()`;

const WINDOWS = ["chat", "skills", "projects", "routines", "dashboard", "settings", "persona", "about", "notes", "plan"];

test("every component window clears WCAG AA text contrast in both themes", async () => {
  const home = await makeBeanHome();
  // Two saved chats (one with an agent) so the history sidebar's rows, groups and mini-avatars are measured.
  const db = dbFile(join(home.homeDir, ".bean"));
  saveDesktopChat(db, { id: "11111111-1111-4111-8111-111111111111", title: "Plan the week", itemsJson: JSON.stringify([{ kind: "reply", agent: "claude", text: "ok" }]) });
  saveDesktopChat(db, { id: "22222222-2222-4222-8222-222222222222", title: "Older chat", itemsJson: "[]" }, new Date(Date.now() - 3 * 86_400_000));
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
      // Seed the chat transcript with a Bean reply so its mascot row is measured too. The CLI
      // agents' mascots have no producer until Agent mode (#477) — seed them there.
      // The renderer subscribes in a mount effect, after domcontentloaded, and a push sent before
      // that is dropped — so re-send until the row shows (a duplicate row is harmless here).
      if (kind === "chat") {
        await expect(async () => {
          await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!
              .webContents.send("bean:interrupted-run-notice", [{ text: "Seeded reply", display: "Seeded reply" }]);
          });
          await win.locator(".bean-chat-row .bean-agent-avatar--bean").first().waitFor({ timeout: 1000 });
        }).toPass({ timeout: 10_000 });
      }
      await win.waitForTimeout(600);
      for (const theme of ["hearth", "graphite"]) {
        await win.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        expect(await win.evaluate(SCAN), `${kind} / ${theme}`).toEqual([]);
      }
      // #505: the history sidebar inline (default width) is covered above; narrow the window and
      // scan its overlay too.
      if (kind === "chat") {
        await expect(win.locator(".bean-chat-sidebar")).toBeVisible();
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.setSize(500, 600);
        });
        await expect(win.locator(".bean-chat-sidebar")).toHaveCount(0);
        await win.locator(".bean-chat-sidebar-toggle").click();
        await expect(win.locator(".bean-chat-sidebar--overlay")).toBeVisible();
        for (const theme of ["hearth", "graphite"]) {
          await win.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          expect(await win.evaluate(SCAN), `chat overlay / ${theme}`).toEqual([]);
        }
        await win.keyboard.press("Escape");
        await expect(win.locator(".bean-chat-sidebar--overlay")).toHaveCount(0);
      }
      await win.close();
    }
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
