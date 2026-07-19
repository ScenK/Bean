import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const CLI_NAMES = ["opencode", "claude", "codex"] as const;
export type CliName = (typeof CLI_NAMES)[number];
export type LaunchMode = CliName | "open";

const defaultIsExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Which of Bean's supported CLIs are on PATH — drives the Plan window's CLI picker.
 * Sync PATH scan, no child processes; call once at startup and cache. */
export function detectClis(
  pathEnv: string = process.env.PATH ?? "",
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): CliName[] {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const onPath = (cmd: CliName): boolean => dirs.some((d) => isExecutable(join(d, cmd)));
  return CLI_NAMES.filter(onPath);
}

export type SpawnSyncFn = (command: string, args: string[]) => { stdout?: string };
const defaultSpawnSync: SpawnSyncFn = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 3000 });

/** Finder/Dock-launched (packaged) apps get launchd's minimal PATH — none of the dirs a
 * login shell profile adds (nvm, volta, npm/pnpm global bins, ~/.local/bin, ...), which is
 * where CLIs like `claude` commonly live. Ask the user's actual login shell instead of
 * guessing directories; feeds into detectClis alongside process.env.PATH. */
export function loginShellPath(
  shell: string = process.env.SHELL ?? "/bin/zsh",
  run: SpawnSyncFn = defaultSpawnSync,
): string {
  try {
    return run(shell, ["-ilc", "echo -n $PATH"]).stdout?.trim() ?? "";
  } catch {
    return "";
  }
}

export interface LaunchRequest {
  mode: LaunchMode;
  // "" = no project picked (2a) — the IPC launch handler resolves this to a bare scratch-
  // workspace dir (scratchDir in config.ts) before launchCommand ever sees it. Bean never
  // seeds this dir itself (no git clone/page fetch) — a URL the user typed is folded into
  // `prompt` instead, and the launched agent fetches/clones it itself if it needs to.
  projectPath: string;
  prompt?: string; // required for "opencode"/"claude"/"codex", ignored for "open"
  model?: string; // literal --model value (clis.json); ignored for "open"
}

export function launchCommand(req: LaunchRequest, editorApp?: string): { command: string; args: string[] } {
  switch (req.mode) {
    // Interactive session with an initial prompt — not `opencode run` / `claude -p`,
    // which reply once and exit. This drops the user into the normal TUI/REPL with the message
    // pre-sent, so they can keep working after it replies.
    case "opencode": {
      // --prompt=… as one token: a prompt starting with "-" (e.g. leftover frontmatter "---")
      // would otherwise be eaten by opencode's flag parser, launching the TUI with no prompt.
      return {
        command: "opencode",
        args: [req.projectPath, `--prompt=${req.prompt ?? ""}`, ...(req.model ? ["--model", req.model] : [])],
      };
    }
    case "claude":
      return { command: "claude", args: [...(req.model ? ["--model", req.model] : []), req.prompt ?? ""] };
    case "codex":
      return { command: "codex", args: [...(req.model ? ["--model", req.model] : []), req.prompt ?? ""] };
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
  // Without this, an ENOENT (opencode/claude/codex/editor/open not on PATH) would surface as an
  // unhandled 'error' event and crash the Electron main process.
  child.on("error", onError);
}

// Bean's job ends here: hand the command off and stop tracking it. "opencode"/"claude"/"codex"
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
