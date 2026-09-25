// What a chatops bot is doing, reported to the desktop app so the avatar's status bubbles can
// show it. The bots are separate processes: they send these over Node's IPC channel
// (process.send) when the app spawned them, and drop them when run standalone.
// Privacy: carries who/where (sender + channel name) and error text, never message text or
// delegate output (which can quote messages or secrets) — a run reports only its phase.
export type ChatopsActivity =
  | { type: "turn"; phase: "start" | "end"; id: string; who: string; where?: string; error?: string }
  | { type: "run"; phase: "start" | "done" | "failed" | "cancelled"; id: string; name: string; error?: string }
  | { type: "live"; phase: "start" | "end"; id: string; name: string; error?: string };

export type ChatopsActivitySink = (e: ChatopsActivity) => void;

const MAX = 300;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, MAX) : undefined);
const PHASES: Record<ChatopsActivity["type"], readonly string[]> = {
  turn: ["start", "end"],
  run: ["start", "done", "failed", "cancelled"],
  live: ["start", "end"],
};

/** Validate an event that crossed the process boundary; anything malformed is dropped. */
export function parseChatopsActivity(v: unknown): ChatopsActivity | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  // Strings first: Object.hasOwn coerces its key, and a crafted object there would throw.
  if (typeof o.type !== "string" || typeof o.phase !== "string") return undefined;
  const type = o.type as ChatopsActivity["type"];
  const id = str(o.id);
  if (!Object.hasOwn(PHASES, type) || !PHASES[type].includes(o.phase) || !id) return undefined;
  const phase = o.phase as never;
  const error = str(o.error);
  if (type === "turn") return { type, phase, id, who: str(o.who) ?? "someone", where: str(o.where), error };
  if (type === "run") return { type, phase, id, name: str(o.name) ?? "delegate", error };
  return { type, phase, id, name: str(o.name) ?? "live session", error };
}

/** Sink for a bot server: forwards to the parent app over IPC, a no-op when there is none.
 * The callback form keeps a closed channel (app gone) from surfacing as an unhandled
 * process 'error' event, which would kill the bot. */
export const parentActivitySink: ChatopsActivitySink = (e) => {
  if (process.send && process.connected) process.send(e, undefined, {}, () => {});
};
