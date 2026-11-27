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
  /** Automatic follow-ups Bean already ran on this task (#1132), at most FOLLOW_UP_MAX. */
  followUps?: number;
  /** The failure the last automatic follow-up answered (`failureFingerprint`): the same one again stops the chain. */
  lastFailure?: string;
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
  | "none" | "revoked" | "expired" | "stale" | "busy" | "budget" | "repeat"
  | "surface" | "scope" | "actor" | "project" | "cli" | "model" | "skill" | "browser";

export type GrantMatch = { ok: true; grant: DelegateGrant } | { ok: false; reason: GrantMismatch };

/** The status line shown beside the fallback card. */
export const GRANT_MISMATCH_TEXT: Record<GrantMismatch, string> = {
  none: "No agent session to continue here, so this needs a new card.",
  revoked: "That agent session was closed, so this needs a new card.",
  expired: "That agent session sat idle for 30 minutes, so this needs a new card.",
  stale: "That agent session was replaced, so this needs a new card.",
  // The host's check (matchGrant can't see runs): a running delegate or a live session holds it.
  busy: "That agent session is still busy, so this needs a new card.",
  // Automatic follow-ups only (matchFollowUp, #1132).
  budget: "Bean already followed up twice on that task.",
  repeat: "The agent hit the same failure again.",
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

/** Automatic follow-ups per task (#1132): Bean's own turn on a delegate's end may continue its session
 * at most this often; then it asks the user. */
export const FOLLOW_UP_MAX = 2;

/** A failure reason, normalized so the same failure with other numbers/spacing compares equal. */
export const failureFingerprint = (message: string): string =>
  message.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** May Bean's own turn on a settled run follow up on it without the user (#1132)? The grant must match
 * (`req.generation` = the one the run settled on), the budget hold, and a failure not repeat the one the
 * last follow-up answered. `failure` = the settled run's failure reason (absent: it finished). */
export function matchFollowUp(grant: DelegateGrant | undefined, req: GrantRequest, failure: string | undefined, now: number): GrantMatch {
  const m = matchGrant(grant, req, now);
  if (!m.ok) return m;
  if ((m.grant.followUps ?? 0) >= FOLLOW_UP_MAX) return { ok: false, reason: "budget" };
  if (failure !== undefined && m.grant.lastFailure === failureFingerprint(failure)) return { ok: false, reason: "repeat" };
  return m;
}

/** An automatic follow-up starts: it spends one of the budget and remembers the failure it answers.
 * Never renews the idle clock — only the user's own turns do. */
export function reserveFollowUp(grant: DelegateGrant, failure: string | undefined): DelegateGrant {
  const { lastFailure: _l, ...rest } = grant;
  return { ...rest, followUps: (grant.followUps ?? 0) + 1, ...(failure !== undefined ? { lastFailure: failureFingerprint(failure) } : {}) };
}

/** Rides Bean's turn on a settled run it may follow up on (code-built, appended by the host). */
export const followUpNote = (n: number): string =>
  `(Bean may continue this task's agent session on its own — follow-up ${n} of ${FOLLOW_UP_MAX}. If the task is ` +
  "only partly done and the agent can finish what's left within the same task and skill, call propose_delegate " +
  "with continue: true and a short instruction for just what's left. Don't follow up — ask the user instead — " +
  "when it needs the user's decision or input, would message other people, spend money, or delete or publish " +
  "anything beyond the task, or needs a different skill.)";

/** Why an automatic follow-up was refused, as one sentence (no card is offered in its place). */
const refusedWhy = (reason: GrantMismatch): string => GRANT_MISMATCH_TEXT[reason].replace(/, so this needs a new card\.$/, ".");

/** Rides Bean's turn on a settled run it may not follow up on (budget spent, same failure, lapsed). */
export const followUpRefusedNote = (reason: GrantMismatch): string =>
  `(No automatic follow-up: ${refusedWhy(reason)} Tell the user what's still open and ask how they want to go on.)`;

/** What the chat shows when Bean wanted to follow up but the host refused it. */
export const followUpRefusedText = (reason: GrantMismatch): string =>
  `Bean stopped following up on its own: ${refusedWhy(reason)} Reply to tell it how to go on.`;
