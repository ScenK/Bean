import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { can, cardActionNeeds, dmAllowed, makeRoles, parseRoleCommand, type Capability } from "../src/chatops/roles.js";

const db = (): string => join(mkdtempSync(join(tmpdir(), "bean-roles-")), "bean.db");

test("owner matches on either Teams id; admins are per scope; everyone else is a guest", () => {
  const roles = makeRoles({ dbPath: db(), surface: "teams", ownerId: "aad-owner" });
  expect(roles.roleOf({ fromId: "29:owner", fromAltId: "aad-owner" })).toBe("owner");
  expect(roles.roleOf({ fromId: "29:ana", scopeId: "chan" })).toBe("guest");
  expect(roles.addAdmins("chan", [{ id: "29:ana", name: "A[n]a\n" }])).toEqual(["29:ana"]);
  expect(roles.roleOf({ fromId: "29:ana", scopeId: "chan" })).toBe("admin");
  expect(roles.roleOf({ fromId: "29:ana", scopeId: "other" })).toBe("guest");
  expect(roles.roleOf({ fromId: "29:ana" })).toBe("guest"); // no scope (DM) = no admins
  expect(roles.admins("chan")).toEqual([{ id: "29:ana", name: "Ana" }]);
  roles.touch("chan", "29:ana", "Ana B");
  expect(roles.admins("chan")[0]?.name).toBe("Ana B");
  expect(roles.removeAdmins("chan", ["29:ana", "29:nobody"])).toEqual(["29:ana"]);
  expect(roles.roleOf({ fromId: "29:ana", scopeId: "chan" })).toBe("guest");
});

test("admins are per surface", () => {
  const dbPath = db();
  makeRoles({ dbPath, surface: "discord", ownerId: "o" }).addAdmins("chan", [{ id: "u", name: "U" }]);
  expect(makeRoles({ dbPath, surface: "teams", ownerId: "o" }).roleOf({ fromId: "u", scopeId: "chan" })).toBe("guest");
});

test("setup mode (no owner) and a missing actor id fail closed", () => {
  const roles = makeRoles({ dbPath: db(), surface: "teams" });
  expect(roles.roleOf({ fromId: "29:anyone" })).toBe("guest");
  roles.addAdmins("chan", [{ id: "29:ana", name: "Ana" }]); // a grant left over from before
  expect(roles.roleOf({ fromId: "29:ana", scopeId: "chan" })).toBe("guest");
  expect(makeRoles({ dbPath: db(), surface: "teams", ownerId: "o" }).roleOf({ fromId: "" })).toBe("guest");
  expect(roles.allowGuestDms).toBe(false);
});

test("card actions: live-session and skill controls are owner-only, notes/todos/forget member, the rest admin", () => {
  for (const a of ["start-live", "cancel-live", "resume-live", "live-mode", "live-editsubmit", "save-skill", "cancel-skill", "save-routine", "cancel-routine", "toggle-routine"]) {
    expect(cardActionNeeds(a)).toBe("owner");
  }
  for (const a of ["save-note", "cancel-note", "archive-note", "cancel-archive-note", "restore-note", "queue-todo", "cancel-todo", "forget-memory", "cancel-reminder"]) {
    expect(cardActionNeeds(a)).toBe("member");
  }
  for (const a of ["confirm", "cancel-proposal", "cancel-run", "skill", "cli", "model", "delegate-edit", "delegate-editsubmit", undefined]) {
    expect(cardActionNeeds(a)).toBe("admin");
  }
});

test("members are household-wide (DMs too), win over admin grants, and need an owner configured", () => {
  const roles = makeRoles({ dbPath: db(), surface: "discord", ownerId: "o", memberIds: ["m"] });
  expect(roles.roleOf({ fromId: "m" })).toBe("member");
  expect(roles.roleOf({ fromId: "m", scopeId: "chan" })).toBe("member");
  roles.addAdmins("chan", [{ id: "m", name: "M" }]); // membership is checked first
  expect(roles.roleOf({ fromId: "m", scopeId: "chan" })).toBe("member");
  expect(makeRoles({ dbPath: db(), surface: "discord", memberIds: ["m"] }).roleOf({ fromId: "m" })).toBe("guest");
  expect(can("member", "memory") && can("member", "notes") && can("member", "todos")).toBe(true);
  expect(["delegate", "systemControl", "liveSession", "skillWrites", "cancelRuns"].some((c) => can("member", c as Capability))).toBe(false);
  expect(dmAllowed("member", roles) && !dmAllowed("guest", roles)).toBe(true);
});

test("role commands parse with an optional leading slash", () => {
  expect(parseRoleCommand("/whoami")).toBe("whoami");
  expect(parseRoleCommand(" Admins ")).toBe("admins");
  expect(parseRoleCommand("add-admin <@1>")).toBe("add-admin");
  expect(parseRoleCommand("remove-admin @Ana")).toBe("remove-admin");
  expect(parseRoleCommand("admins are cool")).toBeUndefined();
  expect(parseRoleCommand("add-administrator")).toBeUndefined();
});
