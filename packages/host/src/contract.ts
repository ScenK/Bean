// The service contract a shell speaks to a host (#807): a version, a handshake naming what the host
// machine can do, and the runtime guards every adapter runs a payload through before a handler sees it.
// The per-channel table lives beside the channel names (app/src/channel-contract.ts).

/** Bump on any breaking change to a channel's arguments, results or events.
 * v2 (#975): `chat` history is the turns after the shell's rolling `summary`, and the reply may carry
 * a new one — a v1 core would drop the summary's context, a v1 shell would re-summarize every turn.
 * v3 (#976): Home is one fixed thread; `chatThreadGet("home")` no longer carries `home.until` — a v2
 * shell would end Home's "day" the moment it opened.
 * v4 (#997): Home's model history can be the core's main log — `chat` takes a keyed `delta` instead of
 * history, and `chatThreadGet("home")` says so (`home.log`); a v3 shell would keep sending history.
 * v5 (#1000): Home pulls the owner's DM rows (`chatMainSince`, the `main` push); a v4 core refuses the
 * pull, so its shell would connect fine and never show a DM exchange. Also `getPersona` (#1001, same
 * unreleased stack): the main conversation's name. Ship #1000 alone and this needs a v6.
 * v6 (#1113): a `chat` reply may carry `continuedDelegate` — a run the core already started with no
 * card — and `delegateNotice`; `delegateRevoke` ends a chat's task grant. A v5 shell would leave that
 * run invisible and never revoke the grant. */
export const CONTRACT_VERSION = 6;

/** What the host machine offers beyond core: Mac system controls, a Terminal.app handoff, chat pty
 * terminals, and opening/picking paths on its desktop. Host-bound channels each need one. */
export const CAPABILITIES = ["systemControls", "terminalHandoff", "pty", "pathOpen"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Handshake {
  contract: number;
  /** The core build's version. */
  core: string;
  platform: string;
  capabilities: Capability[];
}

export const buildHandshake = (core: string, platform: string, capabilities: Capability[]): Handshake =>
  ({ contract: CONTRACT_VERSION, core, platform, capabilities });

export type HandshakeCheck =
  | { ok: true; handshake: Handshake }
  | { ok: false; reason: "version" | "malformed"; message: string };

/** A shell's check of the handshake a host sent: a contract version mismatch is reported as such,
 * apart from a malformed reply. A capability this shell doesn't know is dropped, not refused (#838):
 * adding one to a newer core mustn't break every older shell. */
export function checkHandshake(v: unknown, expected = CONTRACT_VERSION): HandshakeCheck {
  if (!obj(v) || typeof v.contract !== "number") return { ok: false, reason: "malformed", message: "The core sent a malformed handshake." };
  if (v.contract !== expected) {
    return {
      ok: false, reason: "version",
      message: `Contract version mismatch: the core speaks v${v.contract}, this shell speaks v${expected}. Update the older one.`,
    };
  }
  const caps = v.capabilities;
  if (typeof v.core !== "string" || typeof v.platform !== "string" || !Array.isArray(caps)
    || !caps.every((c) => typeof c === "string")) {
    return { ok: false, reason: "malformed", message: "The core sent a malformed handshake." };
  }
  const known = caps.filter((c): c is Capability => (CAPABILITIES as readonly unknown[]).includes(c));
  return { ok: true, handshake: { contract: v.contract, core: v.core, platform: v.platform, capabilities: known } };
}

// Hand-written guards (no schema dependency). Shallow on purpose: they check what crosses the wire
// is the declared shape; handlers still validate contents (ids, paths, enums) themselves.
export type Guard = (v: unknown) => boolean;
function obj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
export const guard = {
  str: ((v) => typeof v === "string") as Guard,
  num: ((v) => typeof v === "number" && Number.isFinite(v)) as Guard,
  bool: ((v) => typeof v === "boolean") as Guard,
  none: ((v) => v === undefined) as Guard,
  bytes: ((v) => v instanceof Uint8Array) as Guard,
  obj: obj as Guard,
  arr: (g: Guard): Guard => (v) => Array.isArray(v) && v.every(g),
  opt: (g: Guard): Guard => (v) => v === undefined || g(v),
  nullable: (g: Guard): Guard => (v) => v === null || g(v),
  oneOf: (...values: readonly unknown[]): Guard => (v) => values.includes(v),
  either: (...gs: Guard[]): Guard => (v) => gs.some((g) => g(v)),
  /** An object whose listed fields pass (wrap optional ones in `opt`); unlisted fields pass through. */
  shape: (fields: Record<string, Guard>): Guard => (v) => obj(v) && Object.entries(fields).every(([k, g]) => g(v[k])),
};

/** A call's arguments against its guards: no extras; a missing trailing one is `undefined`. */
export const argsOk = (guards: readonly Guard[], args: readonly unknown[]): boolean =>
  args.length <= guards.length && guards.every((g, i) => g(args[i]));
