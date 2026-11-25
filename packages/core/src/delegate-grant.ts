import type { CliName } from "./launcher.js";

/** A confirmed delegate card authorizes one task, not one run: follow-ups in the same scope continue
 * the run's agent session without a new card while this grant matches. Pure and memory-only — a
 * restart drops every grant (fail closed: cards again). The host owns the store and the busy check. */
export interface DelegateGrant {
  surface: "desktop" | "discord" | "teams";
  /** The desktop chat mount id, or the real chatops conversation/thread id. */
  scopeKey: string;
  /** Who confirmed the card — the only one who continues without a card. */
  actorId: string;
  projectPath: string;
  cli: CliName;
  model?: string;
  skillName?: string;
  /** The skill's `browser: true` at confirm time; a continuation never adds it. */
  browser: boolean;
  /** The CLI's own session id the confirmed run produced — host-internal, never shown to the model. */
  sessionId: string;
  lastActivity: number; // epoch ms
  /** Bumped by every createGrant over a previous grant in the scope, so a continuation checked
   * against an older grant (revoked, replaced) can't ride a newer one. */
  generation: number;
  revoked?: true;
}

export const GRANT_IDLE_MS = 30 * 60_000;

/** A continuation request: scope and actor always; each selector only when named explicitly —
 * an omitted one inherits the grant. */
export interface GrantRequest {
  surface: DelegateGrant["surface"];
  scopeKey: string;
  actorId: string;
  projectPath?: string;
  cli?: CliName;
  model?: string;
  skillName?: string;
  browser?: boolean;
  /** The generation the caller saw when it offered the continuation. */
  generation?: number;
}

export type GrantMismatch =
  | "none" | "revoked" | "expired" | "stale"
  | "surface" | "scope" | "actor" | "project" | "cli" | "model" | "skill" | "browser";

export type GrantMatch = { ok: true; grant: DelegateGrant } | { ok: false; reason: GrantMismatch };

/** The status line shown beside the fallback card. */
export const GRANT_MISMATCH_TEXT: Record<GrantMismatch, string> = {
  none: "No agent session to continue here, so this needs a new card.",
  revoked: "That agent session was closed, so this needs a new card.",
  expired: "That agent session sat idle for 30 minutes, so this needs a new card.",
  stale: "That agent session was replaced, so this needs a new card.",
  surface: "That agent session belongs to another chat, so this needs a new card.",
  scope: "That agent session belongs to another chat, so this needs a new card.",
  actor: "Only the person who started that agent session can continue it without a card.",
  project: "That's another project than the agent session's, so this needs a new card.",
  cli: "That's another agent than the session's, so this needs a new card.",
  model: "That's another model than the session's, so this needs a new card.",
  skill: "That's another skill than the session's, so this needs a new card.",
  browser: "That needs browser access the session wasn't started with, so this needs a new card.",
};

export function createGrant(
  fields: Omit<DelegateGrant, "lastActivity" | "generation" | "revoked">,
  now: number,
  previous?: DelegateGrant,
): DelegateGrant {
  return { ...fields, lastActivity: now, generation: (previous?.generation ?? 0) + 1 };
}

export const isGrantExpired = (grant: DelegateGrant, now: number): boolean => now - grant.lastActivity >= GRANT_IDLE_MS;

export function matchGrant(grant: DelegateGrant | undefined, req: GrantRequest, now: number): GrantMatch {
  const no = (reason: GrantMismatch): GrantMatch => ({ ok: false, reason });
  if (!grant) return no("none");
  if (grant.revoked) return no("revoked");
  if (isGrantExpired(grant, now)) return no("expired");
  if (req.generation !== undefined && req.generation !== grant.generation) return no("stale");
  if (req.surface !== grant.surface) return no("surface");
  if (req.scopeKey !== grant.scopeKey) return no("scope");
  if (req.actorId !== grant.actorId) return no("actor");
  if (req.projectPath !== undefined && req.projectPath !== grant.projectPath) return no("project");
  if (req.cli !== undefined && req.cli !== grant.cli) return no("cli");
  if (req.model !== undefined && req.model !== grant.model) return no("model");
  if (req.skillName !== undefined && req.skillName !== grant.skillName) return no("skill");
  if (req.browser !== undefined && req.browser !== grant.browser) return no("browser");
  return { ok: true, grant };
}

/** A continuation ran on the grant: restart its idle clock. */
export const refreshGrant = (grant: DelegateGrant, now: number): DelegateGrant => ({ ...grant, lastActivity: now });

/** `/new`, End, Dismiss, window close / mount release. Kept (not dropped) so the next createGrant
 * in the scope still bumps the generation. */
export const revokeGrant = (grant: DelegateGrant): DelegateGrant => ({ ...grant, revoked: true });
