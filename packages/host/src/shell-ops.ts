/** A renderer client. Electron: its webContents id — only the app's adapter knows that. */
export type ClientId = number;

/** The desktop shell's native operations — dialogs, Finder, the browser, window sizing. The host
 * never imports Electron; the app implements this (`app/src/shell-ops.ts`) and injects it. */
export interface ShellOps {
  /** A folder picker over the client's window; undefined = cancelled. */
  pickFolder: (clientId: ClientId) => Promise<string | undefined>;
  /** An application (`.app`) picker starting in /Applications; undefined = cancelled. */
  pickApp: (clientId: ClientId) => Promise<string | undefined>;
  /** Shows the path in Finder. */
  reveal: (path: string) => void;
  /** Opens the path with its default app; rejects with the OS's error. */
  openPath: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** Grows/shrinks the client's window to `height` (width kept), clamped to its display's work area. */
  fitHeight: (clientId: ClientId, height: number) => void;
}

/** A host push to one chat (mount): the shell adapter maps each kind to its channel and routes it
 * to the client that holds (or last held) the mount. */
export type MountPushKind = "delegate" | "live" | "memory" | "imageProgress";
export type HostPush = (mountId: string, kind: MountPushKind, payload: unknown) => void;
