import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, lineSplitter, type BridgeConnection } from "./mcp-bridge.js";
import { MCP_SOCKET_NAME } from "./mcp-tools.js";

// The stdio MCP server each AI app spawns (#225): `<Bean exe> <mcp-shim.cjs>` with
// ELECTRON_RUN_AS_NODE=1, so it needs no system node and never touches the single-instance lock.
// It only pipes to Bean.app's socket (logic in mcp-bridge.ts); it never opens bean.db itself.
// stdout carries MCP only — diagnostics go to stderr.

const socketPath = join(homedir(), ".bean", MCP_SOCKET_NAME);

const bridge = createBridge({
  version: process.env.BEAN_VERSION ?? "0.0.0",
  latestProtocol: LATEST_PROTOCOL_VERSION,
  supportedProtocols: SUPPORTED_PROTOCOL_VERSIONS,
  out: (line) => { process.stdout.write(`${line}\n`); },
  connect: (onLine, onClose) =>
    new Promise<BridgeConnection | undefined>((resolve) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => socket.destroy(), 2000);
      let up = false;
      socket.once("connect", () => {
        up = true;
        clearTimeout(timer);
        resolve({ write: (line) => { socket.write(`${line}\n`); }, close: () => socket.end() });
      });
      socket.on("data", lineSplitter(onLine));
      socket.on("error", () => {}); // "close" follows; a failed connect just means Bean is closed
      socket.once("close", () => {
        clearTimeout(timer);
        if (up) onClose();
        else resolve(undefined);
      });
    }),
});

process.stdin.on("data", lineSplitter((line) => { void bridge.input(line); }));
// The client hung up: let queued lines finish forwarding, then go.
process.stdin.once("end", () => {
  void bridge.input("").then(() => {
    bridge.close();
    process.exit(0);
  });
});
