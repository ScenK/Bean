import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";

/** Who is speaking on a chat surface (see .memory/safety-chatops-roles.md). Owner: one person,
 * from config. Member: household-wide, from config (DMs too). Admin: granted per channel/group
 * chat by the owner. Guest: everyone else. */
export type Role = "owner" | "admin" | "member" | "guest";

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role, need: Role): boolean => RANK[role] >= RANK[need];

/** The least role each gated capability needs — the one table the tool list, the runtime
 * checks and the card gates read, so they can't drift apart. */
const NEEDS = {
  memory: "member", notes: "member", todos: "member", reminders: "member", fresh: "member",
  delegate: "admin", runSkills: "admin", images: "admin", cancelRuns: "admin",
  systemControl: "owner", liveSession: "owner", skillWrites: "owner", routineWrites: "owner", manageAdmins: "owner",
} as const satisfies Record<string, Role>;
export type Capability = keyof typeof NEEDS;
export const needs = (cap: Capability): Role => NEEDS[cap];
export const can = (role: Role, cap: Capability): boolean => atLeast(role, NEEDS[cap]);

/** Members and up always DM; guests only with config `allowGuestDms`. */
export const dmAllowed = (role: Role, roles: Roles): boolean => atLeast(role, "member") || roles.allowGuestDms;

/** Identity comes only from platform SDK ids — never display names, card payloads or model text. */
export interface Speaker {
  fromId: string;
  /** Teams' AAD object id (the owner may be configured by either id). */
  fromAltId?: string;
  /** Admin scope: the channel / group chat, not the thread. Absent = no admins (a DM). */
  scopeId?: string;
}

export interface Roles {
  ownerName: string;
  /** Config `allowGuestDms`: false = non-owner DMs get one fixed line and nothing else. */
  allowGuestDms: boolean;
  roleOf(who: Speaker): Role;
  admins(scopeId: string | undefined): { id: string; name: string }[];
  /** Ids actually added/removed. */
  addAdmins(scopeId: string, users: { id: string; name: string }[]): string[];
  removeAdmins(scopeId: string, ids: string[]): string[];
  /** Display-only name refresh for an existing admin row. */
  touch(scopeId: string | undefined, id: string, name: string): void;
}

export interface RolesOptions {
  dbPath: string;
  surface: "discord" | "teams";
  /** Unset = setup mode: everyone is a guest (fail closed). */
  ownerId?: string;
  /** Household members (platform ids), global — DMs included. Read once; a change needs a restart. */
  memberIds?: string[];
  ownerName?: string;
  allowGuestDms?: boolean;
}

export function makeRoles(opts: RolesOptions): Roles {
  const db: DatabaseSync = openDb(opts.dbPath);
  const { surface } = opts;
  const members = new Set(opts.memberIds ?? []);
  const isAdmin = (scopeId: string, ids: string[]): boolean =>
    ids.some((id) => db.prepare(
      "SELECT 1 FROM chatops_admins WHERE surface = ? AND scope_id = ? AND user_id = ?",
    ).get(surface, scopeId, id) !== undefined);
  return {
    ownerName: opts.ownerName || "the owner",
    allowGuestDms: opts.allowGuestDms ?? false,
    roleOf({ fromId, fromAltId, scopeId }) {
      const ids = [fromId, fromAltId].filter((x): x is string => !!x);
      // No owner configured (setup mode) = everyone is a guest, stored admin grants included.
      if (ids.length === 0 || !opts.ownerId) return "guest";
      if (ids.includes(opts.ownerId)) return "owner";
      // Members are checked before channel admin grants: a household member stays a member.
      if (ids.some((id) => members.has(id))) return "member";
      return scopeId && isAdmin(scopeId, ids) ? "admin" : "guest";
    },
    admins(scopeId) {
      if (!scopeId) return [];
      return db.prepare(
        "SELECT user_id AS id, name FROM chatops_admins WHERE surface = ? AND scope_id = ? ORDER BY granted_at",
      ).all(surface, scopeId) as unknown as { id: string; name: string }[];
    },
    addAdmins(scopeId, users) {
      const now = new Date().toISOString();
      return users.filter((u) => u.id !== opts.ownerId && Number(db.prepare(
        "INSERT OR IGNORE INTO chatops_admins (surface, scope_id, user_id, name, granted_at) VALUES (?, ?, ?, ?, ?)",
      ).run(surface, scopeId, u.id, cleanName(u.name), now).changes) > 0).map((u) => u.id);
    },
    removeAdmins(scopeId, ids) {
      return ids.filter((id) => Number(db.prepare(
        "DELETE FROM chatops_admins WHERE surface = ? AND scope_id = ? AND user_id = ?",
      ).run(surface, scopeId, id).changes) > 0);
    },
    touch(scopeId, id, name) {
      if (!scopeId) return;
      db.prepare("UPDATE chatops_admins SET name = ? WHERE surface = ? AND scope_id = ? AND user_id = ?")
        .run(cleanName(name), surface, scopeId, id);
    },
  };
}

// Admin names reach the model's role line: strip brackets/newlines and cap, like speakerLine.
const cleanName = (name: string): string => name.replace(/[[\]\r\n]/g, "").trim().slice(0, 64) || "someone";

const list = (names: string[]): string => names.length > 0 ? names.join(", ") : "none yet";

/** Gated capability (admins and owner). `what` reads after "I can't", e.g. "save memories". */
export function gatedRefusal(what: string, roles: Roles, scopeId: string | undefined): string {
  return `Sorry, I can't ${what} for you here. That's for ${roles.ownerName} and this chat's admins ` +
    `(${list(roles.admins(scopeId).map((a) => a.name))}). Ask one of them, or ask ${roles.ownerName} to make you an admin.`;
}

export function ownerOnlyRefusal(what: string, roles: Roles): string {
  return `Only ${roles.ownerName} can ${what}.`;
}

export const dmRefusal = (roles: Roles): string =>
  `Hi! I only take direct messages from ${roles.ownerName}'s household. To be added, send ${roles.ownerName} ` +
  "the id from `whoami`. Or mention me in a shared chat and I'll help there.";

/** A member asking for an admin/owner capability: not "ask to be made admin" — the owner sets those up. */
export const memberRefusal = (what: string, roles: Roles): string =>
  `Sorry, I can't ${what} for you. Routines and coding tasks are set up by ${roles.ownerName}.`;

/** What `role` hears when refused something that needs `need`. */
export function refusal(need: Role, role: Role, what: string, roles: Roles, scopeId: string | undefined): string {
  // A member hears the member line even for owner-only things: the owner sets those up for them.
  if (role === "member") return memberRefusal(what, roles);
  return need === "owner" ? ownerOnlyRefusal(what, roles) : gatedRefusal(what, roles, scopeId);
}

/** Card-tap counterpart of `refusal`. */
export const cardTapRefusal = (need: Role, role: Role, roles: Roles): string =>
  need === "owner" ? ownerOnlyRefusal("confirm this", roles)
    : role === "member" ? memberRefusal("confirm this", roles) : cardRefusal(roles);

export const cardRefusal = (roles: Roles): string => `Only ${roles.ownerName} or an admin here can confirm this.`;

/** Role a card action needs. Discord-only component ids (live-* selects/modals, delegate edits,
 * cli/model/skill selects) map here too so the surface can gate them before touching state. */
export function cardActionNeeds(beanAction: string | undefined): Role {
  const a = beanAction ?? "";
  if (a.startsWith("live-") || a.endsWith("-live") || a === "save-skill" || a === "cancel-skill" || a.endsWith("-routine")) return "owner";
  if (a === "save-note" || a === "cancel-note") return needs("notes");
  if (a === "queue-todo" || a === "cancel-todo") return needs("todos");
  if (a === "forget-memory") return needs("memory");
  if (a === "cancel-reminder") return needs("reminders");
  return "admin";
}

/** `add-admin` / `remove-admin` / `admins` / `whoami`, with an optional leading slash. */
export function parseRoleCommand(text: string): "add-admin" | "remove-admin" | "admins" | "whoami" | undefined {
  const t = text.trim().toLowerCase().replace(/^\/+/, "");
  if (t === "admins" || t === "whoami") return t;
  if (/^add-admin\b/.test(t)) return "add-admin";
  if (/^remove-admin\b/.test(t)) return "remove-admin";
  return undefined;
}

/** Per-turn guidance for the model (trailing system message). Guidance only — enforcement is
 * the tool list plus bot.ts's runtime checks. */
export function roleLine(role: Role, roles: Roles, scopeId: string | undefined): string {
  if (role === "owner") return "The current speaker is your owner.";
  const ownerOnly = ownerOnlyRefusal("start a live session, save skills or routines, or control the Mac", roles);
  if (role === "admin") {
    return "The current speaker is an admin of this chat (not your owner). If they ask for a live " +
      `session, a new or changed skill or routine, or Mac control, reply exactly: "${ownerOnly}"`;
  }
  if (role === "member") {
    return "The current speaker is a household member (not your owner): memories, notes, reminders and task " +
      "queues are open to them, but delegation, live sessions, skills, routines, images and Mac control are not. " +
      `If they ask for one of those, reply exactly: "${memberRefusal("do that", roles)}" Never claim you did it.`;
  }
  return "The current speaker is a guest: you have no memories, notes, tasks or delegation for them. " +
    "If they ask you to remember or forget something, set a reminder, look up or save a note, or run, queue or " +
    `delegate a task, reply exactly: "${gatedRefusal("do that", roles, scopeId)}" Never claim you did it.`;
}
