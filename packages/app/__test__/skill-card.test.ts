import { expect, test, vi } from "vitest";
import type { Skill } from "@bean/core";

// The card's two useState calls are name and body; the test edits them through `edited`.
const edited = vi.hoisted(() => ({ name: undefined as string | undefined, body: undefined as string | undefined, n: 0 }));
vi.mock("preact/hooks", () => ({
  useState: <T,>(initial: T) => [(edited.n++ % 2 === 0 ? edited.name : edited.body) ?? initial, () => {}] as const,
}));

import { SkillCard } from "../src/renderer/components/chat/SkillCard.js";

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  return text((value as { props?: { children?: unknown } }).props?.children);
}

const skills: Skill[] = [{ name: "web", description: "d", body: "b", enabled: true, browser: true }];

function chips(name: string, body: string, edit: { name?: string; body?: string } = {}): string {
  edited.n = 0;
  edited.name = edit.name;
  edited.body = edit.body;
  return text(SkillCard({ skill: { name, body, updating: false }, skills, state: "pending", onSave: () => {}, onDismiss: () => {} }));
}

test("the browser chip follows the edited body's frontmatter against the existing skill", () => {
  expect(chips("new", "---\nbrowser: true\n---\n# N")).toContain("🌐 uses your browser");
  expect(chips("new", "# N\n\nbrowser: true")).not.toContain("🌐");
  expect(chips("web", "---\ntarget: terminal\n---\n# W")).toContain("🌐 no longer uses your browser");
  // Live: editing the body or renaming onto the browser skill recomputes it.
  expect(chips("new", "# N", { body: "---\nbrowser: true\n---\n# N" })).toContain("🌐 uses your browser");
  expect(chips("new", "# N", { name: "web" })).toContain("🌐 no longer uses your browser");
});
