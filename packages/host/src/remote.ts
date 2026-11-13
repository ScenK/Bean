import { coreSocketFile } from "@bean/core";
import { chmodSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { Attachments } from "./attachments.js";
import { busyLabel, type CoreUpdateResult, type CoreUpdateStatus } from "./core-update.js";
import { argsOk, CONTRACT_VERSION, guard as g, type Guard, type Handshake } from "./contract.js";
import type { HostHandlers } from "./host.js";
import type { ClientId } from "./shell-ops.js";

// Remote attach (#809): bean-core listens on a unix socket inside the 0700 data directory — never a
// TCP port — and a shell on another machine reaches it through SSH only, with `bean-core attach`
// piping stdio to that socket (`ssh <host> bean-core attach`, or `… docker exec -i <c> bean-core
// attach`). The wire is length-prefixed JSON frames (4-byte big-endian length, then UTF-8 JSON):
//
//   shell → core: {type:"attach", shellId, contract} first, then {type:"call", id, op, args},
//                 {type:"heartbeat", acks?}, {type:"resume", acks}, {type:"detach"}
//   core → shell: {type:"attached", handshake, generation, clientId}, {type:"result", id, ok, value|error},
//                 the attachment's {type:"push"…} / {type:"revoked"}, and {type:"error", message} before a close
//
// `bean-core update` (#837) sends {type:"update", force} as its first frame instead — no attachment,
// so it never displaces a shell — and gets one {type:"update", result} back before the close. An
// attached shell updates through the coreUpdateStatus / coreUpdateApply ops (#838): no arguments
// beyond `force` (no URL, path or key), the new core must speak this contract, and an "updated"
// answer is flushed before the core exits.
//
// Only the operations in REMOTE_OPS run (default deny): core channels a remote shell needs, never raw
// config / API-key reads, path opens, pty or the Terminal hand-off. Settings (#812) reads the config
// with the key blanked and saves a patch — the key is write-only from here.

/** One frame's body. Chat requests carry base64 images, hence well above a text turn. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Frames queued to a shell that stopped reading: past this the connection drops; the shell catches
 * up through the attachment's replay when it reconnects. */
export const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
/** Calls a connection may have running at once. */
export const MAX_IN_FLIGHT = 32;

/** A frame, or undefined when its body is over MAX_FRAME_BYTES. */
export function encodeFrame(msg: unknown): Buffer | undefined {
  const body = Buffer.from(JSON.stringify(msg) ?? "null", "utf8");
  if (body.length > MAX_FRAME_BYTES) return undefined;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames. A declared length over the cap fails on the header, before its
 * body is buffered; after a failure every later chunk is ignored. */
export function frameReader(onFrame: (msg: unknown) => void, onError: (why: string) => void): (chunk: Buffer) => void {
  let chunks: Buffer[] = [];
  let size = 0;
  let need = 4;
  let dead = false;
  return (chunk) => {
    if (dead) return;
    chunks.push(chunk);
    size += chunk.length;
    while (!dead && size >= need) {
      const buf = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        dead = true;
        onError(`frame of ${len} bytes is over the ${MAX_FRAME_BYTES}-byte cap`);
        return;
      }
      if (buf.length < 4 + len) {
        chunks = [buf];
        need = 4 + len;
        return;
      }
      const rest = buf.subarray(4 + len);
      chunks = rest.length > 0 ? [rest] : [];
      size = rest.length;
      need = 4;
      let msg: unknown;
      try { msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")); } catch {
        dead = true;
        onError("malformed frame");
        return;
      }
      onFrame(msg);
    }
  };
}

// Argument guards, in the same order as the IPC channels of the same name (app/src/channel-contract.ts;
// its test checks every op here is a `core` channel with the same arity).
const { str, num, bool, obj, arr, opt, oneOf, shape } = g;
const turn = shape({ role: oneOf("user", "assistant", "system"), content: str, id: opt(str) });
const chatRequest = shape({
  history: arr(turn), message: str, source: opt(str), incognito: opt(bool), droppedUrl: opt(str),
  linkedNote: opt(obj), images: opt(arr(shape({ data: str, mimeType: str }))), documents: opt(arr(() => true)), turnId: opt(str),
});
const closeOpts = shape({ incognito: bool, rejected: arr(str), mountId: str });
const delegateStart = shape({ projectPath: str, prompt: str, instruction: str, model: opt(str), cli: opt(str), skillName: opt(str) });
const liveStart = shape({
  agent: str, projectPath: str, ask: str, label: opt(str), model: opt(str),
  history: opt(arr(shape({ role: oneOf("user", "reply"), text: str, agent: opt(str) }))),
});

const configPatch = shape({
  openaiApiKey: opt(str), model: opt(str), terminalApp: opt(str), editorApp: opt(str), delegateCli: opt(str),
  systemControls: opt(bool), reasoningEffort: opt(str), routineDigestContext: opt(bool), disabledClis: opt(arr(str)),
  webSearch: opt(bool), autoMemory: opt(bool),
});
const project = shape({ name: str, path: str, defaultSkill: opt(str), skills: opt(arr(str)) });

/** A remote shell types a project's path (it has no folder picker on this machine): a new or changed
 * path must be an absolute directory here. Paths already saved pass, so a moved repo can't block an
 * unrelated edit. */
export async function checkRemoteProjects(h: Pick<HostHandlers, "listProjects">, next: { path: string }[]): Promise<void> {
  const saved = new Set((await h.listProjects()).map((p) => p.path));
  for (const { path } of next) {
    if (saved.has(path)) continue;
    let dir = false;
    try { dir = isAbsolute(path) && statSync(path).isDirectory(); } catch { /* missing */ }
    if (!dir) throw new Error(`No folder at "${path}" on the core — use an absolute path on that machine.`);
  }
}

// `any[]`: the arguments have passed `args` by the time these run; the handlers check contents.
type Run = (h: HostHandlers, client: ClientId, ...args: any[]) => unknown;
interface RemoteOp {
  args: readonly Guard[];
  run: (d: RemoteDeps, client: ClientId, ...args: any[]) => unknown;
}
const op = (run: Run, ...args: Guard[]): RemoteOp => ({ args, run: (d, c, ...a) => run(d.handlers, c, ...a) });
/** A core without the self-update (the desktop's own, or a test) refuses these like an unknown op. */
const updates = (d: RemoteDeps): { update: NonNullable<RemoteDeps["update"]>; updateStatus: NonNullable<RemoteDeps["updateStatus"]> } => {
  if (!d.update || !d.updateStatus) throw new Error("This core can't update itself remotely.");
  return { update: d.update, updateStatus: d.updateStatus };
};
/** What a shell gets back from coreUpdateApply: the busy list as labels, like coreUpdateStatus's. */
export type RemoteUpdateResult =
  | Exclude<CoreUpdateResult, { status: "busy" } | { status: "updated" }>
  | { status: "busy"; version: string; busy: string[] }
  | { status: "updated"; from: string; version: string; stopped: string[] };
const forShell = (r: CoreUpdateResult): RemoteUpdateResult => (r.status === "busy" ? { ...r, busy: r.busy.map(busyLabel) }
  : r.status === "updated" ? { ...r, stopped: r.stopped.map(busyLabel) } : r);

/** The remote-safe operations — everything else is refused. Each is a `core` channel; the chat ones
 * are checked per chat (client + attached mount) by the host's chat sessions. */
export const REMOTE_OPS: Readonly<Record<string, RemoteOp>> = {
  chatAttach: op((h, c, mountId) => h.chat.attach(c, mountId), str),
  chatRelease: op((h, c, mountId) => h.chat.release(c, mountId), str),
  chat: op((h, c, req, mountId) => h.chat.chat(c, mountId, req), chatRequest, str),
  chatStop: op((h, c, mountId, turnId) => h.chat.stop(c, mountId, turnId), str, str),
  chatIncognito: op((h, c, on, mountId) => h.chat.incognito(c, mountId, on), bool, str),
  rememberOnClose: op((h, c, transcript, opts) => h.chat.rememberOnClose(c, transcript, opts), arr(turn), closeOpts),
  delegateStart: op((h, c, req, mountId) => h.chat.delegateStart(c, mountId, req), delegateStart, str),
  delegateCancel: op((h, _c, taskId) => h.cancelDelegate(taskId), str),
  liveStart: op((h, c, req, mountId) => h.chat.liveStart(c, mountId, req), liveStart, str),
  liveSend: op((h, c, sessionId, text, mountId) => h.chat.liveSend(c, mountId, sessionId, text), str, str, str),
  liveStop: op((h, c, sessionId, mountId) => h.chat.liveStop(c, mountId, sessionId), str, str),
  liveInterrupt: op((h, c, sessionId, mountId, turns) => h.chat.liveInterrupt(c, mountId, sessionId, turns), str, str, num),
  liveResume: op((h, c, sessionId, mountId) => h.chat.liveResume(c, mountId, sessionId), str, str),
  getModel: op((h) => h.getModel()),
  // Never the key itself: `apiKeySet` says whether one is saved.
  getConfig: op((h) => ({ ...h.getConfig(), openaiApiKey: "" })),
  saveConfig: op((h, _c, patch) => h.applyConfig(patch), configPatch),
  detectedClis: op((h) => h.detectedClis()),
  listSkills: op((h) => h.listSkills()),
  listProjects: op((h) => h.listProjects()),
  saveProjects: op(async (h, _c, projects) => {
    await checkRemoteProjects(h, projects);
    return h.saveProjects(projects);
  }, arr(project)),
  availableClis: op((h) => h.availableClis()),
  availableModels: op((h) => h.models()),
  // The core's self-update from a shell's About (#838).
  coreUpdateStatus: { args: [], run: (d) => updates(d).updateStatus() },
  coreUpdateApply: { args: [bool], run: async (d, _c, force: boolean) => forShell(await updates(d).update(force, CONTRACT_VERSION)) },
};

export interface RemoteDeps {
  handshake: Handshake;
  attachments: Pick<Attachments, "attach" | "run" | "heartbeat" | "resume" | "detach">;
  handlers: HostHandlers;
  /** The core self-update (`bean-core update`, and a shell's coreUpdateApply with its `contract`);
   * absent = refused like any unknown first frame. */
  update?: (force: boolean, contract?: number) => Promise<CoreUpdateResult>;
  /** A shell's coreUpdateStatus (#838). */
  updateStatus?: () => Promise<CoreUpdateStatus>;
  /** An "updated" result has been written out: exit now, so the service manager starts the new version. */
  onUpdated?: () => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Never String() wire data: a frame like {"toString":0} makes the coercion throw.
const message = (err: unknown): string => (err instanceof Error ? err.message : "The call failed.");

/** One shell connection: the attach handshake first, then calls, heartbeats, resume and detach. */
export function serveConnection(sock: Socket, deps: RemoteDeps): void {
  let attached: { generation: number; clientId: ClientId } | undefined;
  let inFlight = 0;
  // Set on a refusal, detach or revocation: frames already read (same chunk) are ignored after it.
  let closed = false;
  const close = (): void => {
    closed = true;
    sock.end();
  };
  const send = (m: unknown): boolean => {
    if (sock.destroyed || sock.writableEnded) return true;
    if (sock.writableLength > MAX_OUTBOX_BYTES) { sock.destroy(); return true; }
    const frame = encodeFrame(m);
    if (!frame) return false;
    sock.write(frame);
    return true;
  };
  const fail = (why: string): void => {
    send({ type: "error", message: why });
    close();
  };
  const update = (force: boolean, run: NonNullable<RemoteDeps["update"]>): void => {
    closed = true; // one request per connection
    void run(force).catch((err: unknown): CoreUpdateResult => ({ status: "error", message: message(err) })).then((result) => {
      send({ type: "update", result });
      sock.end(() => { if (result.status === "updated") deps.onUpdated?.(); });
    });
  };
  const hello = (msg: unknown): void => {
    if (isObj(msg) && msg.type === "update" && deps.update) return update(msg.force === true, deps.update);
    if (!isObj(msg) || msg.type !== "attach") return fail("The first frame must be the attach handshake.");
    if (msg.contract !== CONTRACT_VERSION) {
      send({ type: "error", handshake: deps.handshake, message: `Contract version mismatch: the core speaks v${CONTRACT_VERSION}.` });
      return close();
    }
    try {
      attached = deps.attachments.attach(msg.shellId, (m) => {
        send(m);
        if (m.type === "revoked") close(); // displaced: its later requests would be stale anyway
      });
    } catch (err) { return fail(message(err)); }
    send({ type: "attached", handshake: deps.handshake, ...attached });
  };
  const call = (msg: Record<string, unknown>, a: NonNullable<typeof attached>): void => {
    const id = msg.id;
    if (typeof id !== "number") return fail("malformed call");
    const reply = (r: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      if (!send({ type: "result", id, ...r })) send({ type: "result", id, ok: false, error: "The result is over the frame cap." });
    };
    const name = msg.op;
    const remote = typeof name === "string" && Object.hasOwn(REMOTE_OPS, name) ? REMOTE_OPS[name] : undefined;
    if (!remote) return reply({ ok: false, error: `${typeof name === "string" ? name : "That operation"} is not allowed over a remote attach.` });
    const args = msg.args ?? [];
    if (!Array.isArray(args) || !argsOk(remote.args, args)) return reply({ ok: false, error: `Malformed arguments for ${name}.` });
    if (inFlight >= MAX_IN_FLIGHT) return reply({ ok: false, error: "Too many calls in flight." });
    inFlight++;
    deps.attachments.run(a.generation, () => remote.run(deps, a.clientId, ...args))
      .then((value) => {
        reply({ ok: true, value });
        // The answer is out: close and exit, so the service manager starts the new version.
        if (name === "coreUpdateApply" && isObj(value) && value.status === "updated") {
          closed = true;
          sock.end(() => deps.onUpdated?.());
        }
      }, (err: unknown) => reply({ ok: false, error: message(err) }))
      .finally(() => { inFlight--; });
  };
  const lifecycle = (fn: () => void): void => {
    try { fn(); } catch (err) { fail(message(err)); }
  };
  const frame = (msg: unknown): void => {
    if (!attached) return hello(msg);
    const a = attached;
    if (!isObj(msg)) return fail("malformed frame");
    switch (msg.type) {
      case "call": return call(msg, a);
      case "heartbeat": return lifecycle(() => deps.attachments.heartbeat(a.generation, msg.acks));
      case "resume": return lifecycle(() => deps.attachments.resume(a.generation, msg.acks));
      case "detach":
        lifecycle(() => deps.attachments.detach(a.generation));
        return close();
      default: return fail("unknown frame type");
    }
  };
  sock.on("data", frameReader((msg) => {
    if (closed) return;
    // Whatever a frame does, a throw closes only this connection — never the core.
    try { frame(msg); } catch { fail("malformed frame"); }
  }, fail));
  // A dropped connection is not a detach: the heartbeat watchdog disconnects it and its chats get the grace.
  sock.on("error", () => {});
}

/** Listens on `<dir>/core.sock` (0600) — only inside a private (0700) directory this user owns. A
 * stale socket from a crash is replaced; a live one (another bean-core on this data) is not. */
export async function listenRemote(dir: string, deps: RemoteDeps): Promise<{ path: string; close: () => void }> {
  const st = lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`${dir} must be a private (0700) directory owned by this user.`);
  }
  const path = coreSocketFile(dir);
  await clearStale(path);
  const server = createServer((sock) => serveConnection(sock, deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  server.on("error", (err) => console.error("bean-core: attach socket failed", err));
  return {
    path,
    close: () => {
      server.close();
      try { unlinkSync(path); } catch { /* already gone */ }
    },
  };
}

async function clearStale(path: string): Promise<void> {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket.`);
  const live = await new Promise<boolean>((resolve) => {
    const s = connect(path);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  if (live) throw new Error(`another bean-core is already serving ${path}.`);
  unlinkSync(path);
}

/** `bean-core update`'s side of the socket: one update request to the running core. Undefined when
 * no core is listening (stopped or crash-looping). */
export function requestUpdate(path: string, force: boolean): Promise<CoreUpdateResult | undefined> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let answered = false;
    const answer = (r: CoreUpdateResult | undefined): void => {
      answered = true;
      sock.destroy();
      resolve(r);
    };
    sock.once("error", (err: NodeJS.ErrnoException) => {
      if (answered) return;
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") answer(undefined);
      else reject(err);
    });
    sock.once("connect", () => { sock.write(encodeFrame({ type: "update", force })!); });
    sock.on("data", frameReader((m) => {
      if (answered || !isObj(m)) return;
      if (m.type === "update" && isObj(m.result)) answer(m.result as CoreUpdateResult);
      else if (m.type === "error") answer({ status: "error", message: typeof m.message === "string" ? m.message : "The core refused the update." });
    }, (why) => { if (!answered) answer({ status: "error", message: why }); }));
    sock.once("close", () => { if (!answered) reject(new Error("The core closed the connection without answering.")); });
  });
}

/** `bean-core attach`: pipes stdio to the core's socket, byte for byte (the core enforces the frames).
 * Resolves when the core has closed the connection and everything it sent is written to `output`. */
export function attachStdio(path: string, input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once("error", reject);
    sock.once("connect", () => {
      input.pipe(sock);
      sock.pipe(output, { end: false });
    });
    // Resolve once the output has flushed: exiting on the socket's close alone truncates a slow stdout.
    sock.once("close", () => output.end(() => resolve()));
  });
}
