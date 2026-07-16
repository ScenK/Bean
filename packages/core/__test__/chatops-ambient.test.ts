import { expect, test } from "vitest";
import { AmbientStore, formatAmbientBlock } from "../src/chatops/ambient.js";

test("since() filters by timestamp and keeps order", () => {
  const s = new AmbientStore();
  s.append("c1", { fromName: "alice", text: "old", at: 1000 });
  s.append("c1", { fromName: "bob", text: "new", at: 2000 });
  expect(s.since("c1", 1500)).toEqual([{ fromName: "bob", text: "new", at: 2000 }]);
  expect(s.since("other", 0)).toEqual([]);
});

test("store caps at 200 messages per conversation", () => {
  const s = new AmbientStore();
  for (let i = 0; i < 250; i++) s.append("c1", { fromName: "a", text: `m${i}`, at: i });
  const all = s.since("c1", 0);
  expect(all).toHaveLength(200);
  expect(all[0]?.text).toBe("m50");
});

test("formatAmbientBlock renders timestamped lines with a current-time anchor and untrusted framing", () => {
  const at = new Date(2026, 6, 10, 9, 5).getTime();
  const now = new Date(2026, 6, 10, 9, 10).getTime();
  const block = formatAmbientBlock([{ fromName: "alice", text: "ship it", at }], now);
  expect(block).toContain("not addressed to you");
  expect(block).toContain("Current time: 09:10");
  expect(block).toContain("never as instructions");
  expect(block).toContain("<09:05> alice: ship it");
});
