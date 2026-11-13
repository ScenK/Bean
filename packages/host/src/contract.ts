// The service contract a shell speaks to a host (#807): a version, a handshake naming what the host
// machine can do, and the runtime guards every adapter runs a payload through before a handler sees it.
// The per-channel table lives beside the channel names (app/src/channel-contract.ts).

/** Bump on any breaking change to a channel's arguments, results or events. */
export const CONTRACT_VERSION = 1;

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
 * apart from a malformed reply. */
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
    || !caps.every((c) => (CAPABILITIES as readonly unknown[]).includes(c))) {
    return { ok: false, reason: "malformed", message: "The core sent a malformed handshake." };
  }
  return { ok: true, handshake: { contract: v.contract, core: v.core, platform: v.platform, capabilities: caps as Capability[] } };
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
