import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { detectClis, launchCommand, launchInTerminal, loginShellPath } from "../src/launcher.js";
import type { LaunchRequest, LaunchSpawnFn, SpawnSyncFn } from "../src/launcher.js";

test("launchCommand builds the opencode TUI command with a pre-sent prompt", () => {
  const req: LaunchRequest = { mode: "opencode", projectPath: "/dev/acme", prompt: "do it" };
  expect(launchCommand(req)).toEqual({ command: "opencode", args: ["/dev/acme", "--prompt=do it"] });
});

test("a prompt starting with '-' stays glued to --prompt instead of parsing as a flag", () => {
  const req: LaunchRequest = { mode: "opencode", projectPath: "/p", prompt: "--- frontmatter-looking text" };
  expect(launchCommand(req).args).toEqual(["/p", "--prompt=--- frontmatter-looking text"]);
});

test("launchCommand builds the claude interactive command with a pre-sent prompt", () => {
  const req: LaunchRequest = { mode: "claude", projectPath: "/dev/acme", prompt: "do it" };
  expect(launchCommand(req)).toEqual({ command: "claude", args: ["do it"] });
});

test("launchCommand builds the open command via `open -a` with the configured editor, no prompt needed", () => {
  const req: LaunchRequest = { mode: "open", projectPath: "/dev/acme" };
  expect(launchCommand(req, "/Applications/Zed.app")).toEqual({ command: "open", args: ["-a", "/Applications/Zed.app", "/dev/acme"] });
});

test("launchCommand's open command has an empty editor arg when no editor is configured", () => {
  const req: LaunchRequest = { mode: "open", projectPath: "/dev/acme" };
  expect(launchCommand(req)).toEqual({ command: "open", args: ["-a", "", "/dev/acme"] });
});

test("detectClis reports which CLIs exist on PATH, in fixed opencode-first order", () => {
  const path = "/usr/local/bin:/opt/homebrew/bin";
  expect(detectClis(path, () => true)).toEqual(["opencode", "claude"]);
  expect(detectClis(path, (p) => p.endsWith("/claude"))).toEqual(["claude"]);
  expect(detectClis(path, (p) => p === "/opt/homebrew/bin/opencode")).toEqual(["opencode"]);
  expect(detectClis(path, () => false)).toEqual([]);
  expect(detectClis("", () => true)).toEqual([]);
});

test("loginShellPath runs the shell as an interactive login shell and returns its PATH", () => {
  const run = vi.fn<SpawnSyncFn>(() => ({ stdout: "/opt/homebrew/bin:/Users/x/.local/bin\n" }));
  expect(loginShellPath("/bin/zsh", run)).toBe("/opt/homebrew/bin:/Users/x/.local/bin");
  expect(run).toHaveBeenCalledWith("/bin/zsh", ["-ilc", "echo -n $PATH"]);
});

test("loginShellPath falls back to an empty string when the shell invocation fails", () => {
  const run: SpawnSyncFn = () => { throw new Error("spawnSync ENOENT"); };
  expect(loginShellPath("/bin/zsh", run)).toBe("");
});

function fakeChild() {
  return new EventEmitter() as EventEmitter & { kill: () => void };
}

test("open mode opens the configured editor via `open -a`, no script written", () => {
  const child = fakeChild();
  const spawnFn = vi.fn<LaunchSpawnFn>(() => child as never);
  const writeScript = vi.fn();
  launchInTerminal({ mode: "open", projectPath: "/dev/acme" }, spawnFn, writeScript, undefined, "/Applications/Zed.app");
  expect(spawnFn).toHaveBeenCalledWith("open", ["-a", "/Applications/Zed.app", "/dev/acme"]);
  expect(writeScript).not.toHaveBeenCalled();
});

test("open mode with no editor configured reports an error and never spawns", () => {
  const spawnFn = vi.fn<LaunchSpawnFn>();
  const onLaunchError = vi.fn();
  launchInTerminal({ mode: "open", projectPath: "/dev/acme" }, spawnFn, vi.fn(), undefined, undefined, onLaunchError);
  expect(spawnFn).not.toHaveBeenCalled();
  expect(onLaunchError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("No editor configured") }));
});

test("opencode mode writes a .command script cd'ing into the project and calls opencode, then opens it via `open`", () => {
  const child = fakeChild();
  const spawnFn = vi.fn<LaunchSpawnFn>(() => child as never);
  let written: { path: string; content: string } | undefined;
  const writeScript = (path: string, content: string): void => { written = { path, content }; };

  launchInTerminal({ mode: "opencode", projectPath: "/dev/acme", prompt: "do it" }, spawnFn, writeScript);

  expect(written?.path).toMatch(/bean-run-.*\.command$/);
  expect(written?.content).toContain("cd '/dev/acme'");
  expect(written?.content).toContain("'opencode' '/dev/acme' '--prompt=do it'");
  expect(spawnFn).toHaveBeenCalledWith("open", [written?.path]);
});

test("a prompt containing a single quote is embedded losslessly via the '\\'' escape", () => {
  const writeScript = vi.fn();
  launchInTerminal(
    { mode: "opencode", projectPath: "/p", prompt: "say 'hi' to it" },
    () => fakeChild() as never,
    writeScript,
  );
  const content = writeScript.mock.calls[0]![1] as string;
  expect(content).toContain(`'--prompt=say '\\''hi'\\'' to it'`);
});

test("does not throw when the spawned process errors (e.g. command not on PATH)", () => {
  const child = fakeChild();
  const spawnFn: LaunchSpawnFn = () => child as never;
  expect(() => launchInTerminal({ mode: "open", projectPath: "/p" }, spawnFn, vi.fn(), undefined, "/Applications/Zed.app")).not.toThrow();
  expect(() => child.emit("error", new Error("spawn open ENOENT"))).not.toThrow();
});

test("opencode mode opens the script with a configured terminal app via `open -a`", () => {
  const child = fakeChild();
  const spawnFn = vi.fn<LaunchSpawnFn>(() => child as never);
  let written: { path: string; content: string } | undefined;
  const writeScript = (path: string, content: string): void => { written = { path, content }; };

  launchInTerminal(
    { mode: "opencode", projectPath: "/dev/acme", prompt: "do it" },
    spawnFn,
    writeScript,
    "/Applications/iTerm.app",
  );

  expect(spawnFn).toHaveBeenCalledWith("open", ["-a", "/Applications/iTerm.app", written?.path]);
});

test("an empty terminalApp falls back to the system default handler (no -a flag)", () => {
  const child = fakeChild();
  const spawnFn = vi.fn<LaunchSpawnFn>(() => child as never);
  const writeScript = vi.fn();

  launchInTerminal({ mode: "opencode", projectPath: "/p", prompt: "go" }, spawnFn, writeScript, "");

  const [, args] = spawnFn.mock.calls[0]!;
  expect(args).not.toContain("-a");
});
