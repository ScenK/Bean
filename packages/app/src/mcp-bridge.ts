import { StringDecoder } from "node:string_decoder";
import { MCP_TOOLS, NOT_RUNNING } from "./mcp-tools.js";

// The shim's protocol logic (#225), kept apart from its stdio/socket wiring (mcp-shim.ts) so it
// tests without processes. Messages are newline-delimited JSON-RPC (the MCP stdio framing).
//
// - Bean running: bytes go straight through.
// - Bean not running: answers initialize / tools/list / ping itself from MCP_TOOLS, and every
//   tools/call returns isError "Bean isn't running" — the client never marks the server failed.
// - Bean (re)appears mid-session: the next request connects, replays the cached initialize +
//   notifications/initialized first and swallows the replayed initialize's response.
// - A request in flight when the socket dies gets an error, never a replay: its outcome is unknown.

export interface BridgeConnection {
  write: (line: string) => void;
  close: () => void;
}

export interface BridgeDeps {
  /** Connect to Bean's socket; undefined when Bean isn't running. `onLine`/`onClose` belong to
   * this one connection. */
  connect: (onLine: (line: string) => void, onClose: () => void) => Promise<BridgeConnection | undefined>;
  /** One line to the client (stdout). */
  out: (line: string) => void;
  version: string;
  latestProtocol: string;
  supportedProtocols: string[];
}

type Id = string | number;
interface RpcMessage { jsonrpc?: string; id?: Id | null; method?: string; params?: Record<string, unknown> }

const LOST = "Bean disconnected before answering — the call may or may not have run. Check before retrying.";

export function createBridge(deps: BridgeDeps) {
  let conn: BridgeConnection | undefined;
  let init: RpcMessage | undefined;
  let initialized: string | undefined;
  let pending = new Set<string>(); // JSON of client request ids awaiting a reply on `conn`
  let replays = new Set<string>(); // our own replayed-initialize ids, answered by Bean, swallowed
  let replaySeq = 0;
  let chain: Promise<void> = Promise.resolve();

  const reply = (id: Id, result: unknown): void => deps.out(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const error = (id: Id, code: number, message: string): void =>
    deps.out(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

  const open = async (): Promise<BridgeConnection | undefined> => {
    const ownPending = new Set<string>();
    const ownReplays = new Set<string>();
    let c: BridgeConnection | undefined;
    c = await deps.connect(
      (line) => {
        let msg: RpcMessage;
        try { msg = JSON.parse(line) as RpcMessage; } catch { return; }
        const key = msg.id === undefined || msg.id === null ? undefined : JSON.stringify(msg.id);
        if (key !== undefined && msg.method === undefined) {
          if (ownReplays.delete(key)) return;
          ownPending.delete(key);
        }
        deps.out(line);
      },
      () => {
        if (conn !== c) return;
        conn = undefined;
        for (const key of ownPending) error(JSON.parse(key) as Id, -32000, LOST);
        ownPending.clear();
      },
    );
    if (!c) return undefined;
    pending = ownPending;
    replays = ownReplays;
    return c;
  };

  const offline = (msg: RpcMessage & { id: Id }): void => {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && deps.supportedProtocols.includes(asked) ? asked : deps.latestProtocol;
        reply(msg.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "bean", version: deps.version } });
        return;
      }
      case "tools/list": reply(msg.id, { tools: MCP_TOOLS }); return;
      case "ping": reply(msg.id, {}); return;
      case "tools/call": reply(msg.id, { content: [{ type: "text", text: NOT_RUNNING }], isError: true }); return;
      default: error(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };

  const handle = async (line: string): Promise<void> => {
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const isRequest = typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;

    if (msg.method === "initialize" && isRequest) init = msg;
    if (msg.method === "notifications/initialized") initialized = line;
    if (!isRequest) {
      // Notifications and replies to Bean's own requests: only meaningful on a live connection.
      conn?.write(line);
      return;
    }
    if (!conn) {
      conn = await open();
      if (conn && msg.method !== "initialize" && init) {
        const id = `bean-shim-replay-${++replaySeq}`;
        replays.add(JSON.stringify(id));
        conn.write(JSON.stringify({ ...init, id }));
        if (initialized) conn.write(initialized);
      }
    }
    if (!conn) { offline(msg as RpcMessage & { id: Id }); return; }
    pending.add(JSON.stringify(msg.id));
    conn.write(line);
  };

  return {
    /** One line from the client (stdin), handled strictly in order. */
    input(line: string): Promise<void> {
      if (!line.trim()) return chain;
      chain = chain.then(() => handle(line)).catch(() => {});
      return chain;
    },
    close(): void { conn?.close(); conn = undefined; },
  };
}

/** Splits a byte stream into lines (MCP stdio framing). */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8"); // a multi-byte char can straddle two chunks
  let buf = "";
  return (chunk) => {
    buf += decoder.write(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}
