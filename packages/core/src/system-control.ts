import { execFile } from "node:child_process";
import type { ActionTool } from "./converse.js";

/**
 * System-level controls Bean can perform (macOS). Safety model: the model never writes
 * AppleScript — it picks a verb from this closed union, and each verb maps to a fixed
 * execFile argv below. The one free-text field (app name) is regex-validated and passed
 * as a single argv element, never shell-interpolated.
 */
export type SystemControl =
  | { kind: "volume"; level: number }
  | { kind: "mute"; muted: boolean }
  | { kind: "media"; action: "playpause" | "next" | "previous"; app?: "Music" | "Spotify" }
  | { kind: "app"; action: "launch" | "quit"; name: string };

export type ExecFn = (cmd: string, args: string[]) => Promise<void>;

export const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });

// Any Unicode letter/number plus common name punctuation — but never `"` or `\`, which
// would escape the AppleScript string literal in the quit command.
const APP_NAME = /^[\p{L}\p{N}\p{M}_ .&-]+$/u;
const MEDIA_VERB = { playpause: "playpause", next: "next track", previous: "previous track" } as const;

/** Maps a validated control to fixed argv. Throws on invalid input — callers surface the message. */
export function systemControlCommand(c: SystemControl): { cmd: string; args: string[] } {
  switch (c.kind) {
    case "volume": {
      const level = Math.round(c.level);
      if (!Number.isFinite(level) || level < 0 || level > 100) throw new Error("volume level must be 0-100");
      return { cmd: "osascript", args: ["-e", `set volume output volume ${level}`] };
    }
    case "mute":
      return { cmd: "osascript", args: ["-e", `set volume output muted ${c.muted ? "true" : "false"}`] };
    case "media": {
      const app = c.app ?? "Music";
      if (app !== "Music" && app !== "Spotify") throw new Error("media app must be Music or Spotify");
      const verb = MEDIA_VERB[c.action];
      if (!verb) throw new Error("media action must be playpause, next, or previous");
      return { cmd: "osascript", args: ["-e", `tell application "${app}" to ${verb}`] };
    }
    case "app": {
      if (!APP_NAME.test(c.name)) throw new Error("invalid app name");
      if (c.action === "launch") return { cmd: "open", args: ["-a", c.name] };
      if (c.action === "quit") return { cmd: "osascript", args: ["-e", `quit app "${c.name}"`] };
      throw new Error("app action must be launch or quit");
    }
    default:
      throw new Error("unknown system control");
  }
}

/**
 * The system_control ActionTool for converse(). `enabled` is read per call so the Settings
 * toggle takes effect immediately; when off, the tool reports itself disabled instead of acting.
 */
export function systemControlTool(enabled: () => boolean, exec: ExecFn = defaultExec): ActionTool {
  return {
    spec: {
      name: "system_control",
      description:
        "Control the user's Mac: set output volume, mute/unmute, control music playback " +
        "(Music or Spotify), or launch/quit an application.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["volume", "mute", "media", "app"] },
          level: { type: "number", description: "volume 0-100 (kind: volume)" },
          muted: { type: "boolean", description: "true to mute (kind: mute)" },
          action: {
            type: "string",
            enum: ["playpause", "next", "previous", "launch", "quit"],
            description: "media or app action",
          },
          app: { type: "string", enum: ["Music", "Spotify"], description: "media player (kind: media, default Music)" },
          name: { type: "string", description: "application name (kind: app)" },
        },
        required: ["kind"],
      },
    },
    run: async (args) => {
      if (!enabled()) return "error: system controls are disabled — enable them in Bean's Settings";
      let command: { cmd: string; args: string[] };
      try {
        command = systemControlCommand((args ?? {}) as SystemControl);
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        await exec(command.cmd, command.args);
        return "done";
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
