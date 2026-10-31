import { expect, test } from "vitest";
import { cjkBigrams, ftsMatchQuery } from "../src/fts-text.js";

test("cjkBigrams splits CJK runs into overlapping bigrams and leaves other text alone", () => {
  expect(cjkBigrams("我的牙医是张医生").trim().split(/\s+/)).toEqual(["我的", "的牙", "牙医", "医是", "是张", "张医", "医生"]);
  expect(cjkBigrams("dentist牙医").split(/\s+/).filter(Boolean)).toEqual(["dentist", "牙医"]);
  expect(cjkBigrams("牙").trim()).toBe("牙");
  expect(cjkBigrams("The Q3 roadmap, ships auth-work first!")).toBe("The Q3 roadmap, ships auth-work first!");
});

test("ftsMatchQuery quotes each term, dedupes, and keeps the newest 64", () => {
  expect(ftsMatchQuery("  ")).toBe("");
  expect(ftsMatchQuery('say "hi" 牙医')).toBe('"牙医"* OR """hi"""* OR "say"*');
  const old = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const q = ftsMatchQuery(`${old} 牙医`);
  expect(q.split(" OR ")).toHaveLength(64);
  expect(q).toContain('"牙医"*');
  expect(q).not.toContain('"w0"*');
});
