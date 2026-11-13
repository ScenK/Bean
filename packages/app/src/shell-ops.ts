import { BrowserWindow, dialog, screen, shell, webContents, type OpenDialogOptions } from "electron";
import type { ClientId, ShellOps } from "@bean/host";

/** The Electron side of the host's `ShellOps`: a client id is its webContents id. */
export function createShellOps(): ShellOps {
  const windowOf = (clientId: ClientId): BrowserWindow | undefined => {
    const wc = webContents.fromId(clientId);
    return (wc && BrowserWindow.fromWebContents(wc)) ?? undefined;
  };
  const pick = async (clientId: ClientId, opts: OpenDialogOptions): Promise<string | undefined> => {
    const win = windowOf(clientId);
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? undefined : result.filePaths[0];
  };
  return {
    pickFolder: (clientId) => pick(clientId, { properties: ["openDirectory"] }),
    pickApp: (clientId) => pick(clientId, {
      properties: ["openFile"], filters: [{ name: "Applications", extensions: ["app"] }], defaultPath: "/Applications",
    }),
    reveal: (path) => shell.showItemInFolder(path),
    openPath: async (path) => {
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
    },
    openExternal: (url) => shell.openExternal(url),
    fitHeight: (clientId, height) => {
      const win = windowOf(clientId);
      if (!win) return;
      const [width] = win.getContentSize();
      const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setContentSize(width ?? 0, Math.min(Math.round(height), workArea.height), true);
    },
  };
}
