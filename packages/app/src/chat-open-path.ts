import { basename, extname, isAbsolute, join, resolve } from "node:path";

// Cmd+click on a path printed in the chat (#779). The text is untrusted model/CLI output, so every
// check lives here in main; the renderer only sends the raw token. See .memory/safety-chat-open-path.md.

export const PATH_LIMIT = 4096;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/** The absolute path a Cmd+clicked token names, or undefined (refused). `project` = main's own
 * record of the chat's live-session project; without it only absolute and `~/` paths resolve. */
export function chatPathTarget(raw: unknown, project: string | undefined, home: string): string | undefined {
  if (typeof raw !== "string" || raw.length > PATH_LIMIT || /\p{Cc}/u.test(raw)) return undefined;
  const p = raw.trim().replace(LINE_SUFFIX, "");
  if (!p || SCHEME.test(p)) return undefined;
  if (p === "~" || p.startsWith("~/")) return resolve(join(home, p.slice(1)));
  if (p.startsWith("~")) return undefined; // ~user is never expanded
  if (isAbsolute(p)) return resolve(p);
  return project ? resolve(project, p) : undefined;
}

export type OpenAction = "finder" | "reveal" | "editor";

const TERMINALS = new Set(["terminal", "iterm", "iterm2"]);
const appName = (app: string): string => basename(app.trim()).replace(/\.app$/i, "").toLowerCase();

/** What a click on an existing path does. A directory with an extension (`.app`, `.xcodeproj`, …)
 * is only revealed, so a click never launches a bundle; a terminal "editor" would run a script. */
export function chooseOpen(kind: "dir" | "file" | "other", absPath: string, editorApp: string, terminalApp: string): OpenAction {
  if (kind === "dir") return extname(basename(absPath)) ? "reveal" : "finder";
  if (kind !== "file") return "reveal";
  const editor = appName(editorApp);
  if (!editor || TERMINALS.has(editor) || (terminalApp.trim() && editor === appName(terminalApp))) return "reveal";
  return "editor";
}

export interface OpenPathDeps {
  /** Resolves every symlink: dispatch decides on the real target, so an extensionless link to a
   * `.app` is revealed like the bundle itself, never opened. */
  realpath: (p: string) => Promise<string>;
  stat: (p: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  editorApp: string;
  terminalApp: string;
  /** Finder, into the directory. */
  openDir: (p: string) => Promise<unknown>;
  reveal: (p: string) => void;
  /** `open -a <editorApp> <path>` — rejects when the launch fails. */
  openInEditor: (app: string, p: string) => Promise<unknown>;
}

/** Opens a validated absolute path; a missing one is a no-op. Never throws. */
export async function openChatPath(path: string, deps: OpenPathDeps): Promise<OpenAction | undefined> {
  let kind: "dir" | "file" | "other";
  let absPath: string;
  try {
    absPath = await deps.realpath(path);
    const st = await deps.stat(absPath);
    kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return undefined;
  }
  const action = chooseOpen(kind, absPath, deps.editorApp, deps.terminalApp);
  try {
    if (action === "finder") await deps.openDir(absPath);
    else if (action === "editor") await deps.openInEditor(deps.editorApp.trim(), absPath);
    else deps.reveal(absPath);
    return action;
  } catch {
    // Never the file's default app: a failed editor launch (or Finder) falls back to a reveal.
    deps.reveal(absPath);
    return "reveal";
  }
}
