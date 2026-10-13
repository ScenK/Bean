import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listStepAttempts, parseVerdict, pinStepAttempts, pruneStepAttempts, recordStepAttempt, STEP_OUTPUT_CAP, type StepAttempt } from "../src/step-attempts.js";

const attempt = (runId: string, over: Partial<StepAttempt> = {}): StepAttempt => ({
  runId, routine: "r", stepIndex: 0, round: 1, kind: "delegate", ok: true, output: "out",
  startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:01:00Z", ...over,
});
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "bean-sa-")), "bean.db");

test("parseVerdict takes the last VERDICT line", () => {
  expect(parseVerdict("VERDICT: P0=1\n...\n  VERDICT: P0=0 P1=0  \ntrailer")).toBe("P0=0 P1=0");
  expect(parseVerdict("no verdict here")).toBeUndefined();
  expect(parseVerdict("VERDICT: PASS\r\nVERDICT:   \n")).toBe("PASS");
});

test("parseVerdict stays linear on long whitespace runs", () => {
  const t = performance.now();
  expect(parseVerdict("VERDICT:a" + "\t".repeat(200_000) + "a")).toBe("a" + "\t".repeat(200_000) + "a");
  expect(performance.now() - t).toBeLessThan(500);
});

test("round-trips an attempt by run id, keeping the output's tail up to the cap", () => {
  const file = tmpDb();
  const output = "head" + "x".repeat(STEP_OUTPUT_CAP) + "TAIL";
  recordStepAttempt(file, attempt("run-1", { todoId: "t1", stepId: "plan", cli: "claude", model: "sonnet", sessionId: "s1", verdict: "P0=0", output }));
  recordStepAttempt(file, attempt("run-2"));
  const [a] = listStepAttempts(file, "run-1");
  expect(a).toMatchObject({ todoId: "t1", stepId: "plan", cli: "claude", sessionId: "s1", verdict: "P0=0", ok: true });
  expect(a!.output).toHaveLength(STEP_OUTPUT_CAP);
  expect(a!.output.endsWith("TAIL")).toBe(true);
});

test("prune drops evicted/orphaned runs of that routine only, and keeps pinned rows", () => {
  const file = tmpDb();
  for (const id of ["kept", "evicted", "orphan", "pinned"]) recordStepAttempt(file, attempt(id));
  recordStepAttempt(file, attempt("other", { routine: "other" }));
  pinStepAttempts(file, "pinned", true);
  pruneStepAttempts(file, "r", ["kept"]);
  expect(["kept", "evicted", "orphan", "pinned", "other"].map((id) => listStepAttempts(file, id).length)).toEqual([1, 0, 0, 1, 1]);
  pinStepAttempts(file, "pinned", false);
  pruneStepAttempts(file, "r", ["kept"]);
  expect(listStepAttempts(file, "pinned")).toHaveLength(0);
});
