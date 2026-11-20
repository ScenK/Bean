import { expect, test } from "vitest";
import type { Project, Routine } from "@bean/core";
import {
  ARCHIVED, NEEDS_FIXING, SCRATCH, derivedSectionLabel, folderName, sproutSections, toggleListedUnder,
} from "../src/renderer/components/routines/sprout-sections.js";

const p = (name: string, path = `/w/${name}`): Project => ({ name, path });
const r = (name: string, folders: string[] = [], extra: Partial<Routine> = {}): Routine => ({
  name, enabled: true, cron: "0 8 * * *", sinks: {},
  steps: folders.length > 0 ? folders.map((f) => ({ kind: "delegate", instruction: "x", project: f })) : [{ kind: "chat", instruction: "x" }],
  ...extra,
});
const view = (routines: Routine[], projects: Project[], skills: string[] = []) =>
  sproutSections(routines, projects, new Set(skills)).map((s) => [s.label, s.rows.map((row) => row.routine.name)]);

test("steps inside a registered project (or a sub-folder) list under it, A–Z; no step folder is Scratch", () => {
  const projects = [p("zeta"), p("alpha")];
  expect(view([r("a", ["/w/zeta/sub"]), r("b", ["/w/alpha"]), r("c")], projects))
    .toEqual([["alpha", ["b"]], ["zeta", ["a"]], ["Scratch", ["c"]]]);
});

test("an unregistered step folder is Needs fixing (top), not Scratch; Listed under clears it", () => {
  const projects = [p("app")];
  const loose = r("loose", ["/elsewhere"]);
  expect(view([loose], projects)).toEqual([["Needs fixing", ["loose"]]]);
  const [fix] = sproutSections([loose], projects, new Set());
  expect(fix?.key).toBe(NEEDS_FIXING);
  expect(fix?.rows[0]?.problems).toEqual([{ kind: "unregistered-folder", step: 1, folder: "/elsewhere" }]);
  expect(view([{ ...loose, projects: ["/w/app"] }], projects)).toEqual([["app", ["loose"]]]);
});

test("a sprout under several projects gets one row per section with `also` naming the others", () => {
  const projects = [p("a"), p("b"), p("c")];
  const multi = r("multi", [], { projects: ["/w/a", "/w/b", "/w/c"] });
  const rows = sproutSections([multi], projects, new Set()).map((s) => [s.label, s.rows[0]?.also]);
  expect(rows).toEqual([["a", ["b", "c"]], ["b", ["a", "c"]], ["c", ["a", "b"]]]);
});

test("an archived sprout lists only under Archived, last, whatever its folders (#983)", () => {
  const projects = [p("app")];
  const sections = sproutSections([r("gone", ["/w/app"]), r("loose", ["/elsewhere"]), r("live", ["/w/app"])], projects, new Set(), new Set(["gone", "loose"]));
  expect(sections.map((s) => [s.key, s.rows.map((row) => row.routine.name)])).toEqual([["/w/app", ["live"]], [ARCHIVED, ["gone", "loose"]]]);
});

test("a missing step skill is a row problem, not a section", () => {
  const skilled = r("s", [], { steps: [{ kind: "chat", instruction: "x" }, { kind: "delegate", instruction: "y", skill: "gone" }] });
  const [only] = sproutSections([skilled], [], new Set(["other"]));
  expect(only?.key).toBe(SCRATCH);
  expect(only?.rows[0]?.problems).toEqual([{ kind: "missing-skill", step: 2, skill: "gone" }]);
});

test("Listed under toggles one path, keeps unknown paths and every other draft edit, and drops an emptied list", () => {
  const draft = r("d", [], { description: "unsaved edit", projects: ["/gone"] });
  const on = toggleListedUnder(draft, "/w/a");
  expect(on).toEqual({ ...draft, projects: ["/gone", "/w/a"] });
  expect(toggleListedUnder(toggleListedUnder(r("d"), "/w/a"), "/w/a/")).toEqual(r("d"));
  expect("projects" in toggleListedUnder(r("d", [], { projects: ["/w/a"] }), "/w/a")).toBe(false);
});

test("the editor's empty state names the derived section, ignoring Listed under", () => {
  const projects = [p("app")];
  expect(derivedSectionLabel(r("x", ["/w/app"], { projects: ["/w/other"] }), projects)).toBe("app");
  expect(derivedSectionLabel(r("x", ["/nope"]), projects)).toBe("Needs fixing");
  expect(derivedSectionLabel(r("x"), projects)).toBe("Scratch");
  expect(folderName("/Users/me/code/thing/")).toBe("thing");
});
