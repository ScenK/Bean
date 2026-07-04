import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type LaunchMode = "opencode" | "claude" | "open";

export interface LaunchRequest {
  mode: LaunchMode;
  projectPath: string;
  prompt?: string; // required for "opencode"/"claude", ignored for "open"
}

export function launchCommand(req: LaunchRequest, editorApp?: string): { command: string; args: string[] } {
  switch (req.mode) {
    // Interactive session with an initial prompt for both — not `opencode run` / `claude -p`,
    // which reply once and exit. This drops the user into the normal TUI/REPL with the message
    // pre-sent, so they can keep working after it replies.
    case "opencode":
      return { command: "opencode", args: [req.projectPath, "--prompt", req.prompt ?? ""] };
    case "claude":
      return { command: "claude", args: [req.prompt ?? ""] };
    case "open":
      // editorApp is the user-configured editor .app (Settings); empty = not configured yet,
      // caught by launchInTerminal before ever spawning. `.app` bundles aren't executables
      // themselves (spawning one directly fails with EACCES) — `open -a` is macOS's own way
      // to launch one, same mechanism used for the configured terminal app below.
      return { command: "open", args: ["-a", editorApp ?? "", req.projectPath] };
  }
}

export type LaunchSpawnFn = (command: string, args: string[]) => ChildProcess;
const defaultSpawn: LaunchSpawnFn = (command, args) => spawn(command, args, { stdio: "ignore" });

// Single-quote a shell argument so arbitrary prompt text (quotes, newlines, $, `, ..)
// embeds losslessly: close the quote, escape a literal ', reopen it.
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export type ScriptWriter = (path: string, content: string) => void;
const defaultScriptWriter: ScriptWriter = (path, content) => {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
};

function fireAndForget(child: ChildProcess, onError: (err: Error) => void): void {
  // Without this, an ENOENT (opencode/claude/editor/open not on PATH) would surface as an
  // unhandled 'error' event and crash the Electron main process.
  child.on("error", onError);
}

// Bean's job ends here: hand the command off and stop tracking it. "opencode"/"claude"
// run inside a generated .command script — macOS's double-click-to-run-in-Terminal
// convention, the same mechanism `open` uses on a real double click — so the user
// watches/interacts with the real CLI directly. "open" (the configured editor) is already
// a GUI app, so it's spawned straight, no terminal needed.
// ponytail: one temp .command file per launch, never cleaned up — macOS periodically
// wipes /tmp and these are tiny; add cleanup if that ever bites.
export function launchInTerminal(
  req: LaunchRequest,
  spawnFn: LaunchSpawnFn = defaultSpawn,
  writeScript: ScriptWriter = defaultScriptWriter,
  terminalApp?: string,
  editorApp?: string,
  onLaunchError?: (err: Error) => void,
): void {
  const handleError = onLaunchError ?? ((err) => { console.error("bean: launch failed", err); });

  if (req.mode === "open") {
    if (!editorApp) {
      handleError(new Error("No editor configured — set one in Settings."));
      return;
    }
    const { command, args } = launchCommand(req, editorApp);
    fireAndForget(spawnFn(command, args), handleError);
    return;
  }

  const { command, args } = launchCommand(req);
  const scriptPath = join(tmpdir(), `bean-run-${randomUUID()}.command`);
  const cmdLine = [command, ...args].map(shQuote).join(" ");
  writeScript(
    scriptPath,
    `#!/bin/sh\ncd ${shQuote(req.projectPath)}\n${cmdLine}\necho\necho "[bean] done — press Enter to close"\nread _\n`,
  );
  // An explicit terminalApp opens the script with that app (`open -a`); empty/unset falls back
  // to macOS's own default handler for .command files, exactly like before this option existed.
  const openArgs = terminalApp ? ["-a", terminalApp, scriptPath] : [scriptPath];
  fireAndForget(spawnFn("open", openArgs), handleError);
}
