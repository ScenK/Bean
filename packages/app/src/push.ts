import { CAPABILITIES, type ClientId, type HostPush, type MountPushKind } from "@bean/host";
import { IPC } from "./channels.js";
import { contractRefusal } from "./channel-contract.js";

/** Main → renderer pushes are routed by client and chat (mount) id, never by Electron's
 * webContents, so the state behind them can leave Electron (#801). Every push channel has one
 * route:
 * - `mount` — tagged with a chat's mount id; reaches the client that holds (or last held) it.
 * - `broadcast` — every client; whoever subscribes uses it.
 * - `window` — the Electron shell's own window chrome and open-this-window payloads (avatar
 *   layout, close review, a drop/plan/prompt for the window just opened), sent by main.ts and
 *   avatar-window.ts straight to one BrowserWindow. No registry or IPC handler sends these. */
export const PUSH_ROUTES = {
  [IPC.delegateEvent]: "mount",
  [IPC.liveEvent]: "mount",
  [IPC.terminalEvent]: "mount",
  [IPC.chatImageProgress]: "mount",
  [IPC.memoryUpdated]: "mount",
  [IPC.showChatMount]: "mount",
  [IPC.themeChanged]: "broadcast",
  [IPC.taskStatus]: "broadcast",
  [IPC.chatopsEvent]: "broadcast",
  [IPC.cliAvailabilityChanged]: "broadcast",
  [IPC.syncedChatEvent]: "broadcast",
  // The shell's own attachment state (#811) — every window may show the host badge or a banner.
  [IPC.coreStatusChanged]: "broadcast",
  [IPC.componentDroppedUrl]: "window",
  [IPC.dashboardTarget]: "window",
  [IPC.proposeRun]: "window",
  [IPC.chatPrompt]: "window",
  [IPC.interruptedRunNotice]: "window",
  [IPC.reviewBeforeClose]: "window",
  [IPC.avatarReset]: "window",
  [IPC.avatarFoldMenu]: "window",
  [IPC.avatarDragLayout]: "window",
} as const satisfies Record<string, "mount" | "broadcast" | "window">;

type Routes = typeof PUSH_ROUTES;
type ChannelsOf<R> = { [C in keyof Routes]: Routes[C] extends R ? C : never }[keyof Routes];
export type MountPush = ChannelsOf<"mount">;
export type BroadcastPush = ChannelsOf<"broadcast">;

/** A renderer client. Electron: its webContents id — only the adapter below knows that. */
export type { ClientId };

export interface Push {
  send: (mountId: string, channel: MountPush, payload: unknown) => void;
  broadcast: (channel: BroadcastPush, payload: unknown) => void;
}

/** The host's mount pushes (`HostPush`), by kind → channel. */
export const HOST_PUSH_CHANNELS: Record<MountPushKind, MountPush> = {
  delegate: IPC.delegateEvent, live: IPC.liveEvent, memory: IPC.memoryUpdated, imageProgress: IPC.chatImageProgress,
};
export const hostPush = (push: Push): HostPush => (mountId, kind, payload) => push.send(mountId, HOST_PUSH_CHANNELS[kind], payload);

interface Client { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }

/** The Electron adapter: a mount's client id → its live window contents. A mount whose client is
 * gone drops the push; so does a payload that breaks the contract (channel-contract.ts). Capabilities
 * gate calls, not events, so none are asked here. */
export function createPush(deps: {
  clientOfMount: (mountId: string) => ClientId | undefined;
  client: (id: ClientId) => Client | undefined;
  clients: () => Client[];
}): Push {
  const deliver = (c: Client | undefined, channel: string, payload: unknown): void => {
    const why = contractRefusal(channel, [payload], CAPABILITIES);
    if (why) { console.error(`bean: push dropped — ${why}`); return; }
    if (c && !c.isDestroyed()) c.send(channel, payload);
  };
  return {
    send: (mountId, channel, payload) => {
      const id = deps.clientOfMount(mountId);
      if (id !== undefined) deliver(deps.client(id), channel, payload);
    },
    broadcast: (channel, payload) => { for (const c of deps.clients()) deliver(c, channel, payload); },
  };
}
