import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// WCAG 2.1 contrast guard for the two themes' color tokens. The e2e suite scans the real
// DOM (packages/app/e2e/contrast.e2e.ts) but only in the states a fresh window renders;
// this covers the tokens themselves, including the ones only hover/selected states use.
const css = readFileSync(fileURLToPath(new URL("../src/renderer/theme.css", import.meta.url)), "utf8");

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (c: number) => Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!)];
}

function parseColor(value: string): [number, number, number] {
  const ok = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (ok) return oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  throw new Error(`unsupported color in theme.css: ${value}`);
}

function tokens(theme: string): Record<string, [number, number, number]> {
  const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`))?.[1];
  expect(block, `theme ${theme} missing`).toBeTruthy();
  const out: Record<string, [number, number, number]> = {};
  for (const [, name, value] of block!.matchAll(/(--bean-[\w-]+)\s*:\s*([^;]+);/g)) {
    const raw = value!.split("/*")[0]!.trim();
    if (/\//.test(raw)) continue; // translucent glow tokens sit on top of other art, not text
    out[name!] = parseColor(raw);
  }
  return out;
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const lum = (c: [number, number, number]) => {
    const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ["--bean-bg", "--bean-surface", "--bean-surface-2"] as const;
// Body text (4.5:1) vs. icons and control outlines (3:1).
const TEXT_ON_SURFACE = ["--bean-text", "--bean-text-dim", "--bean-accent", "--bean-link", "--bean-error", "--bean-orb-check-ink"];
const GRAPHIC_ON_SURFACE = ["--bean-star", "--bean-control-border"];

describe.each(["hearth", "graphite"])("%s theme contrast", (theme) => {
  const t = tokens(theme);

  test.each(TEXT_ON_SURFACE)("%s reads as text on every surface (>= 4.5:1)", (name) => {
    for (const surface of SURFACES) expect(contrast(t[name]!, t[surface]!), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  test.each(GRAPHIC_ON_SURFACE)("%s stays visible as a graphic on every surface (>= 3:1)", (name) => {
    for (const surface of SURFACES) expect(contrast(t[name]!, t[surface]!), `${name} on ${surface}`).toBeGreaterThanOrEqual(3);
  });

  test("accent ink reads on an accent fill (buttons, selected rows) >= 4.5:1", () => {
    expect(contrast(t["--bean-accent-ink"]!, t["--bean-accent"]!)).toBeGreaterThanOrEqual(4.5);
  });

  test("toggle knob (accent ink) is distinguishable from both track colors >= 3:1", () => {
    for (const track of ["--bean-accent", "--bean-control-border"]) {
      expect(contrast(t["--bean-accent-ink"]!, t[track]!), `knob on ${track}`).toBeGreaterThanOrEqual(3);
    }
  });
});
