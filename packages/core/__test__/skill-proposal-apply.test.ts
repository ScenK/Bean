import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { closeDb, openDb } from "../src/db.js";
import {
  approveSkillProposal, listSkillProposals, rejectSkillProposal, saveSkillProposals, skillHash, undoSkillProposal,
  type SkillProposal,
} from "../src/retro.js";
import { loadLayeredSkills, saveSkill } from "../src/skill-library.js";
import { listStepAttempts, pruneStepAttempts, recordStepAttempt } from "../src/step-attempts.js";

const files: string[] = [];
afterEach(() => { for (const f of files.splice(0)) closeDb(f); });

function setup(builtin: Record<string, string>, user: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bean-apply-"));
  const dirs = { projectDir: join(root, "builtin"), userDir: join(root, "user") };
  mkdirSync(dirs.projectDir);
  mkdirSync(dirs.userDir);
  for (const [n, b] of Object.entries(builtin)) writeFileSync(join(dirs.projectDir, `${n}.md`), b);
  for (const [n, b] of Object.entries(user)) writeFileSync(join(dirs.userDir, `${n}.md`), b);
  const file = join(root, "bean.db");
  files.push(file);
  const propose = (skill: string, base: string, body: string, id = "p1"): SkillProposal => {
    const p = { id, routine: "sdlc-retro", skill, baseHash: skillHash(base), body, rationale: "r", evidence: ["run-1"], createdAt: "2026-10-13T00:00:00Z" };
    saveSkillProposals(file, [p]);
    return p;
  };
  const effective = async (name: string) => (await loadLayeredSkills(dirs.projectDir, dirs.userDir)).find((s) => s.name === name)?.body;
  return { dirs, file, propose, effective };
}

test("approving a built-in target writes a user override, leaves the repo file alone, and undo removes it", async () => {
  const builtin = "---\ntarget: terminal\n---\n# implement\nold\n";
  const { dirs, file, propose, effective } = setup({ implement: builtin });
  propose("implement", builtin, "---\ntarget: terminal\n---\n# implement\nwrite tests first");

  expect(await approveSkillProposal(file, dirs, "p1")).toEqual({ ok: true });
  expect(await effective("implement")).toBe("---\ntarget: terminal\n---\n# implement\nwrite tests first\n");
  expect(readFileSync(join(dirs.projectDir, "implement.md"), "utf8")).toBe(builtin);
  expect(listSkillProposals(file)).toEqual([]);
  expect(listSkillProposals(file, "applied").map((p) => p.id)).toEqual(["p1"]);

  expect(await undoSkillProposal(file, dirs.userDir, "p1")).toEqual({ ok: true });
  expect(existsSync(join(dirs.userDir, "implement.md"))).toBe(false);
  expect(await effective("implement")).toBe(builtin);
  expect(listSkillProposals(file, "applied")).toEqual([]);
});

test("undo restores the exact prior user file, and is refused after a later manual edit", async () => {
  const prior = "# review\n\nmine, odd   spacing\n\n\n";
  const { dirs, file, propose } = setup({}, { review: prior });
  propose("review", prior, "# review\nbetter");
  expect(await approveSkillProposal(file, dirs, "p1")).toEqual({ ok: true });
  expect(await undoSkillProposal(file, dirs.userDir, "p1")).toEqual({ ok: true });
  expect(readFileSync(join(dirs.userDir, "review.md"), "utf8")).toBe(prior);

  propose("review", prior, "# review\nbetter", "p2");
  expect(await approveSkillProposal(file, dirs, "p2")).toEqual({ ok: true });
  await saveSkill(dirs.userDir, "review", "# review\nhand edit");
  expect(await undoSkillProposal(file, dirs.userDir, "p2")).toEqual({ ok: false, reason: "changed" });
  expect(readFileSync(join(dirs.userDir, "review.md"), "utf8")).toBe("# review\nhand edit\n");
});

test("a stale proposal can't be applied", async () => {
  const { dirs, file, propose } = setup({}, { review: "# review\nv1\n" });
  propose("review", "# review\nv1\n", "# review\nproposed");
  await saveSkill(dirs.userDir, "review", "# review\nv2");
  expect(await approveSkillProposal(file, dirs, "p1")).toEqual({ ok: false, reason: "stale" });
  expect(readFileSync(join(dirs.userDir, "review.md"), "utf8")).toBe("# review\nv2\n");
  expect(listSkillProposals(file).map((p) => p.id)).toEqual(["p1"]);
});

test("a double approve writes once; reject archives and releases the evidence pin", async () => {
  const { dirs, file, propose } = setup({}, { review: "# review\nv1\n" });
  propose("review", "# review\nv1\n", "# review\nproposed");
  const both = await Promise.all([approveSkillProposal(file, dirs, "p1"), approveSkillProposal(file, dirs, "p1")]);
  expect(both).toEqual([{ ok: true }, { ok: false, reason: "gone" }]);
  // The second approve didn't record the first one's output as "previous".
  expect(await undoSkillProposal(file, dirs.userDir, "p1")).toEqual({ ok: true });
  expect(readFileSync(join(dirs.userDir, "review.md"), "utf8")).toBe("# review\nv1\n");

  recordStepAttempt(file, { runId: "run-1", routine: "dev-loop", stepIndex: 0, round: 1, kind: "delegate", ok: true, output: "o", startedAt: "s", finishedAt: "f" });
  propose("review", "# review\nv1\n", "# review\nproposed", "p3");
  expect(await rejectSkillProposal(file, "p3")).toEqual({ ok: true });
  expect(await rejectSkillProposal(file, "p3")).toEqual({ ok: false, reason: "gone" });
  expect(await approveSkillProposal(file, dirs, "p3")).toEqual({ ok: false, reason: "gone" });
  pruneStepAttempts(file, "dev-loop", []);
  expect(listStepAttempts(file, "run-1")).toEqual([]);
});

test("an approve and a reject racing on one proposal: the first wins, the other is refused", async () => {
  const { dirs, file, propose } = setup({}, { review: "# review\nv1\n" });
  propose("review", "# review\nv1\n", "# review\nproposed");
  const [approved, rejected] = await Promise.all([approveSkillProposal(file, dirs, "p1"), rejectSkillProposal(file, "p1")]);
  expect(approved).toEqual({ ok: true });
  expect(rejected).toEqual({ ok: false, reason: "gone" });
  expect(listSkillProposals(file, "applied").map((p) => p.id)).toEqual(["p1"]);
});

test("a bean.db from before the approve columns gets them on open", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-apply-")), "bean.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE skill_proposals (id TEXT PRIMARY KEY, routine TEXT NOT NULL, skill TEXT NOT NULL,
    base_hash TEXT NOT NULL, body TEXT NOT NULL, rationale TEXT NOT NULL, evidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL)`);
  old.close();
  files.push(file);
  openDb(file);
  expect(listSkillProposals(file, "applied")).toEqual([]);
});
