import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildSyncedChatHandlers } from "./synced-chats.js";
import { buildHandshake, createHost, type ChatopsBot, type ChatopsState, type Host } from "@bean/host";
import { buildDeskContinueHandler } from "./desk-continue.js";
import { chatopsMenuRows } from "./chatops-tray-menu.js";
import { installAvatarControls } from "./avatar-window.js";
import { createAvatarLog } from "./avatar-log.js";
import { app, ipcMain, dialog, BrowserWindow, nativeTheme, Notification, Tray, Menu, nativeImage, shell, powerSaveBlocker, powerMonitor, screen, webContents } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import {
  beanDir, ensurePrivateBeanDir, avatarLogFile, projectsFile, skillsDir, projectBeanDir, dbFile, listSkillProposals,
  loadLayeredSkills, loadProjects, planForDroppedSkill, scratchDir, outboxDir, claimOutbox, ackOutbox,
  listChatopsConversations, chatopsConversationTurns, loadChatopsOwners, listDestinations,
} from "@bean/core";
import type { RouteSuggestion, Transport } from "@bean/core";
import { createAvatarWindow, loadAvatarWindow, createComponentWindow } from "./windows.js";
import { registerIpc, buildPlanStore, buildDroppedUrlStore, buildChatPromptStore, buildInterruptedRunStore, notificationOpens, buildPendingUpdateStore, type ChatPromptPayload } from "./ipc.js";
import { IPC, type Theme, type ComponentKind, type DashboardTarget, type ChatDrop } from "./channels.js";
import { saveTheme, themeFile } from "./theme-store.js";
import {
  hasRequestedNotificationPermission, markNotificationPermissionRequested, notificationPermissionFile,
} from "./notification-permission-store.js";
import { sendToWindow, trackComponentWindow } from "./component-window-registry.js";
import { createPush, hostPush } from "./push.js";
import { createTerminalTasks, type PtyFactory, type TerminalTasks } from "./terminal-tasks.js";
import { createShellOps } from "./shell-ops.js";
import { createKeepAwake, keepAwakeFile, keepAwakeTooltip, loadKeepAwake, saveKeepAwake, type KeepAwakeState } from "./keep-awake.js";
import { checkAndDownloadUpdate, installAndRelaunch, cleanupExtractedBundle } from "./updater.js";

// dist/main.js sits next to package.json (esbuild output isn't relocated).
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

// Module-level so the Tray isn't garbage-collected (which removes it from the menu bar).
let tray: Tray | undefined;

// app.exit, not app.quit: quit is async, so whenReady would still fire in the doomed
// duplicate and briefly create a second tray/avatar before dying.
if (!app.requestSingleInstanceLock()) app.exit(0);

// Electron doesn't reliably quit on terminal signals once we hold a tray + hidden dock;
// without this, Ctrl+C on `pnpm dev` (SIGINT) or the dev relauncher's kill (SIGTERM)
// leaves an orphaned Bean holding the single-instance lock.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.quit());

// Every Bean window is a local file:// renderer. A web link in a note/chat body must never
// navigate the window (it would replace the UI with the page) or spawn an Electron popup —
// hand http(s) to the default browser instead. One place, so every surface is covered.
const openExternally = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false;
  void shell.openExternal(url);
  return true;
};
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => { openExternally(url); return { action: "deny" }; });
  contents.on("will-navigate", (e, url) => { if (openExternally(url)) e.preventDefault(); });
});

app.whenReady().then(async () => {
  const dir = beanDir();
  ensurePrivateBeanDir(dir); // before anything below creates ~/.bean world-readable
  // Chat delegates with no project (and project-less routine steps) run here; spawn needs the cwd.
  mkdirSync(scratchDir(dir), { recursive: true });
  // Packaged builds don't contain the monorepo root, so projectBeanDir()'s "../../../.bean"
  // walk resolves outside the app bundle. electron-builder copies .bean into Resources/builtin
  // instead (see package.json build.extraResources) — use that when packaged.
  const projectDir = app.isPackaged ? join(process.resourcesPath, "builtin") : projectBeanDir();

  let quitting = false;
  app.on("before-quit", () => { quitting = true; });
  const avatar = createAvatarWindow();
  // Evidence for a vanished avatar (#757): renderer/GPU deaths, sleep, displays, each recovery click.
  const avatarLogPath = avatarLogFile(dir);
  const writeAvatarLog = createAvatarLog(avatarLogPath);
  let avatarLogOk = true;
  const avatarLog = (event: string, fields?: Record<string, unknown>): void => { avatarLogOk = writeAvatarLog(event, fields); };
  avatar.webContents.on("render-process-gone", (_e, d) => avatarLog("render-process-gone", { reason: d.reason, exitCode: d.exitCode }));
  avatar.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => avatarLog("did-fail-load", { errorCode, errorDescription }));
  avatar.on("unresponsive", () => avatarLog("unresponsive"));
  avatar.on("responsive", () => avatarLog("responsive"));
  app.on("child-process-gone", (_e, d) => avatarLog("child-process-gone", { type: d.type, reason: d.reason, exitCode: d.exitCode }));
  powerMonitor.on("suspend", () => avatarLog("suspend"));
  powerMonitor.on("resume", () => avatarLog("resume"));
  screen.on("display-added", () => avatarLog("display-added"));
  screen.on("display-removed", () => avatarLog("display-removed"));
  const avatarControls = installAvatarControls(avatar, {
    log: (event, fields) => avatarLog(event, event === "bring-back" ? { ...fields, version: pkg.version, os: release() } : fields),
    // Only runs after a reload, long after the host exists.
    replay: () => push.broadcast(IPC.taskStatus, host?.taskStatus.list() ?? []),
    // Non-blocking: main keeps streaming delegates/sessions while this is open.
    fail: () => void dialog.showMessageBox({
      type: "warning",
      message: "Bean couldn't bring the avatar back",
      detail: "Recovery did not stop any running work. Relaunch Bean when it finishes."
        + `\n\n${avatarLogOk ? `Log: ${avatarLogPath}` : "Log unavailable."}`,
    }),
  });
  // e2e hook (avatar-visibility.e2e.ts): the tray menu item isn't reachable from Playwright.
  (globalThis as { beanBringBack?: () => void }).beanBringBack = avatarControls.bringBack;
  // Keep the Mac awake while Bean works, or always if the tray toggle is on (#188).
  const keepAwake = createKeepAwake({
    start: (type) => powerSaveBlocker.start(type),
    stop: (id) => powerSaveBlocker.stop(id),
    onChange: (held) => tray?.setToolTip(keepAwakeTooltip(held)),
  });
  // Main → renderer pushes, by client and chat (mount) id (push.ts). Client = webContents id here
  // only; which client holds a mount comes from the host's chat mounts, once the host exists.
  let host: Host | undefined;
  const push = createPush({
    clientOfMount: (mountId) => host?.handlers.chat.clientOf(mountId),
    client: (id) => webContents.fromId(id),
    clients: () => BrowserWindow.getAllWindows().map((w) => w.webContents),
  });
  let avatarReady = false;
  // Mirrors SettingsWindow.tsx's scheduleErrorClear (same 3s window): a tray-only cache of when
  // each bot's current error first appeared, so the submenu can stop showing a stale error even
  // though the host's bot state (shared with Settings) keeps it until overwritten. Updated by the
  // host's `bots.onEvent` below; read by buildChatopsSubmenu's displayState.
  const CHATOPS_ERROR_DISPLAY_MS = 3000;
  const chatopsErrorSince: Partial<Record<ChatopsBot, number>> = {};
  // Menu-bar app: Cmd+W (the default app-menu Close role) should tuck the pet away, not destroy
  // it, so avatar.html stays loaded once and the bean stays re-summonable. Real quits (Cmd+Q /
  // Exit) set `quitting` first (before-quit, below), so the close proceeds then.
  avatar.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    avatar.hide();
  });

  // A second launch (e.g. double-clicking Bean.app again) just surfaces the bean.
  app.on("second-instance", () => {
    avatarControls.reveal();
  });

  // Monochrome template image (regenerate with scripts/generate-icons.mjs); macOS inverts
  // it automatically for light/dark menu bars. Falls back to 🫘 text if the asset is missing.
  // Representations are added explicitly so retina reliably gets the @2x instead of an
  // upscaled 16px (createFromPath's DPI-suffix detection proved flaky here).
  const assetsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
  const trayIcon = nativeImage.createEmpty();
  for (const [scaleFactor, file] of [[1, "beanTemplate.png"], [2, "beanTemplate@2x.png"]] as const) {
    const png = join(assetsPath, file);
    if (existsSync(png)) trayIcon.addRepresentation({ scaleFactor, buffer: readFileSync(png) });
  }
  trayIcon.setTemplateImage(true);
  // Settings/Persona/About/Exit — the avatar's left-click quick actions (Chat/Skills/Projects/
  // Notes, see QUICK_ACTIONS in renderer/avatar.ts) cover the rest. No right-click on the tray.
  // Icons are SF Symbols via createMenuSymbol (macOS-native, no asset files needed); accelerators
  // follow macOS convention (⌘, for preferences, ⌘Q for quit) — About has none, matching the
  // system App menu, where About never gets a shortcut either.
  const symbol = (name: string) => nativeImage.createMenuSymbol(name);
  // Discord/Teams start/stop, folded into one "Chat Bots" submenu item instead of one tray
  // row per bot. Mirrors SettingsWindow.tsx's own Start/Stop toggle — same host bot
  // supervisor, so both surfaces stay in sync. Rebuilt fresh in buildTrayMenu() below (not just
  // once here) so the checkbox/dot state is current every time the tray menu opens.
  const buildChatopsSubmenu = (): MenuItemConstructorOptions[] => {
    const rawStatus = host?.bots.status() ?? { discord: { running: false, enabled: false }, teams: { running: false, enabled: false } };
    // Drop an error once it's past CHATOPS_ERROR_DISPLAY_MS old — see chatopsErrorSince above.
    const displayState = (bot: ChatopsBot, s: ChatopsState): ChatopsState => {
      const since = chatopsErrorSince[bot];
      const stale = s.error && since !== undefined && Date.now() - since > CHATOPS_ERROR_DISPLAY_MS;
      return stale ? { running: s.running, enabled: s.enabled } : s;
    };
    const status: Record<ChatopsBot, ChatopsState> = {
      discord: displayState("discord", rawStatus.discord),
      teams: displayState("teams", rawStatus.teams),
    };
    const items: MenuItemConstructorOptions[] = [];
    for (const row of chatopsMenuRows(status)) {
      items.push({
        label: `${row.dot} ${row.label}`,
        type: "checkbox",
        checked: row.checked,
        click: () => {
          shell.beep();
          row.checked ? host?.bots.stop(row.bot) : host?.bots.start(row.bot);
        },
      });
      if (row.error) items.push({ label: `⚠️ ${row.error}`, enabled: false });
    }
    return items;
  };
  // Open at Login: the OS login-item registration is the source of truth (no Bean state), read
  // fresh on every rebuild so removing Bean in System Settings → Login Items shows here. Packaged
  // only — dev would register node_modules' Electron.app — and only from /Applications, since a
  // DMG or translocated copy registers a path that later disappears.
  const buildLoginItemRows = (): MenuItemConstructorOptions[] => {
    if (!app.isPackaged) return [];
    if (!app.isInApplicationsFolder()) {
      return [{ label: "Move Bean to Applications to open at login", icon: symbol("power"), enabled: false }];
    }
    const { openAtLogin, status } = app.getLoginItemSettings();
    const rows: MenuItemConstructorOptions[] = [{
      label: "Open at Login",
      icon: symbol("power"),
      type: "checkbox",
      checked: openAtLogin && status !== "requires-approval",
      click: (item) => {
        shell.beep();
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    }];
    if (status === "requires-approval") {
      rows.push({ label: "Approve Bean in System Settings → General → Login Items", enabled: false });
    }
    return rows;
  };
  // Always-on + display persist in userData; loaded right after the tray exists, outside the
  // OpenAI-config `try`, so a bad API key can't leave them off. Both toggles share one chained
  // writer (fixed temp name) that writes the full state.
  const keepAwakePath = keepAwakeFile(app.getPath("userData"));
  let keepAwakeSave: Promise<void> = Promise.resolve();
  const keepAwakeTouched = new Set<keyof KeepAwakeState>(); // clicked before the load landed
  let keepAwakeSaved: KeepAwakeState = { alwaysOn: false, display: false }; // on disk; a failed save reverts to it
  let keepAwakeRev = 0;
  const toggleKeepAwake = (field: keyof KeepAwakeState, on: boolean): void => {
    shell.beep();
    keepAwakeTouched.add(field);
    if (field === "alwaysOn") keepAwake.setAlwaysOn(on);
    else keepAwake.setDisplay(on);
    const rev = ++keepAwakeRev;
    // Snapshot when the save runs (after the load), so an untouched field keeps its persisted value.
    let state: KeepAwakeState;
    keepAwakeSave = keepAwakeSave.then(() => {
      state = { alwaysOn: keepAwake.alwaysOn(), display: keepAwake.display() };
      return saveKeepAwake(keepAwakePath, state);
    }).then(() => { keepAwakeSaved = state; }, (e: unknown) => {
      // Back to what's on disk — only fields whose save never landed actually change.
      if (rev === keepAwakeRev) { keepAwake.setAlwaysOn(keepAwakeSaved.alwaysOn); keepAwake.setDisplay(keepAwakeSaved.display); }
      dialog.showErrorBox(field === "alwaysOn" ? "Keep Mac Awake" : "Keep Display On", `Couldn't save the setting: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  // Retro drafts waiting for review (#263) — shown only when there are some.
  const proposalRows = (): MenuItemConstructorOptions[] => {
    let n = 0;
    try { n = listSkillProposals(dbFile(dir)).length; } catch (err) { console.error("skill proposals count failed:", err); }
    return n ? [{ label: `${n} Skill Proposal${n === 1 ? "" : "s"} Waiting`, icon: symbol("sparkles"), click: () => openComponent("skills") }] : [];
  };
  const buildTrayMenu = (): Menu => Menu.buildFromTemplate([
    { label: "Bring Bean Back", icon: symbol("location"), click: () => avatarControls.bringBack() },
    ...proposalRows(),
    { label: "Settings", icon: symbol("gearshape"), accelerator: "Cmd+,", click: () => openComponent("settings") },
    { label: "Chat Bots", icon: symbol("message"), submenu: buildChatopsSubmenu() },
    { label: "Keep Mac Awake", icon: symbol("cup.and.saucer"), type: "checkbox", checked: keepAwake.alwaysOn(), click: (item) => toggleKeepAwake("alwaysOn", item.checked) },
    // Greyed (no click, no beep) while Keep Mac Awake is off; the remembered choice still shows.
    { label: "Keep Display On", icon: symbol("display"), type: "checkbox", checked: keepAwake.display(), enabled: keepAwake.alwaysOn(), click: (item) => toggleKeepAwake("display", item.checked) },
    ...buildLoginItemRows(),
    { label: "Persona", icon: symbol("person.crop.circle"), accelerator: "Cmd+P", click: () => openComponent("persona") },
    { label: "About", icon: symbol("info.circle"), click: () => openComponent("about") },
    { label: "Exit", icon: symbol("rectangle.portrait.and.arrow.right"), accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
  let trayMenu = buildTrayMenu();
  tray = new Tray(trayIcon);
  if (trayIcon.isEmpty()) tray.setTitle("🫘");
  tray.setToolTip(keepAwakeTooltip(keepAwake.held()));
  // Head of the save chain, so the persisted baseline is set before any early toggle's save runs.
  keepAwakeSave = loadKeepAwake(keepAwakePath).then((state) => {
    keepAwakeSaved = state;
    if (!keepAwakeTouched.has("display")) keepAwake.setDisplay(state.display);
    if (!keepAwakeTouched.has("alwaysOn")) keepAwake.setAlwaysOn(state.alwaysOn);
  });
  // A hidden avatar (tucked away by Cmd+W) is re-summoned by the first tray click; when the
  // bean is already visible, the click pops the menu as usual.
  tray.on("click", () => {
    if (!avatar.isDestroyed() && !avatar.isVisible()) {
      avatarControls.reveal();
      return;
    }
    trayMenu = buildTrayMenu();
    tray?.popUpContextMenu(trayMenu);
  });
  // Menu-bar app: no Dock icon; the tray is the persistent presence. Packaged builds are
  // already dock-less via LSUIElement (package.json build.mac.extendInfo), so this is only a
  // dev-run flip — and it stays AFTER Tray creation, and skipped entirely in dev: macOS 26.5
  // (Tahoe) races async status-item placement and can park the tray icon off-screen when the
  // app flips its activation policy (or owns floating windows) around Tray creation, see
  // .memory/safety-tray-tahoe-placement.md. Dev keeps the Dock icon, which doubles as the
  // re-summon path (the "activate" handler below) when the tray icon loses that race.
  if (app.isPackaged) app.dock?.hide();
  // Dock-icon click (dev only; packaged has no Dock icon) surfaces a Cmd+W-hidden bean —
  // mirrors the tray-click re-summon so a lost tray icon never strands the pet.
  app.on("activate", () => {
    avatarControls.reveal();
  });

  // The host registers its own synchronous teardown (delegates, live sessions, the scheduler and
  // its lease, the routine builder, the Discord and Teams bots) through `onQuit`; the shell-owned
  // pieces stop here.
  let killAllTerminals: () => void = () => {};
  // Chat terminals' shells and their jobs.
  app.on("before-quit", () => killAllTerminals());
  const allowClose = new WeakSet<BrowserWindow>();
  ipcMain.on(IPC.allowChatClose, (evt) => {
    const w = BrowserWindow.fromWebContents(evt.sender);
    if (!w) return;
    allowClose.add(w);
    if (!w.isDestroyed()) w.close();
  });

  const componentWindows = new Map<ComponentKind, BrowserWindow>();
  // Same drop-race fix as planStore below: a URL dropped on the avatar can reach a chat window
  // whose renderer hasn't mounted (and subscribed to componentDroppedUrl) yet, silently losing
  // the push. droppedUrlStore.get() is stashed alongside every push so the renderer can pull it
  // on mount instead.
  const droppedUrlStore = buildDroppedUrlStore();
  // A run to open in the Dashboard: pulled on mount by a fresh (or still-loading) window, pushed to
  // an open one. A mounted window never stores it — that would make a later reopen jump to an old run.
  let pendingDashboardTarget: DashboardTarget | undefined;
  const openComponent = (kind: ComponentKind, payload?: ChatDrop | DashboardTarget): void => {
    const droppedUrl = typeof payload === "string" || Array.isArray(payload) ? payload : undefined;
    const target = typeof payload === "object" && !Array.isArray(payload) && kind === "dashboard" ? payload : undefined;
    const existing = componentWindows.get(kind);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      if (target) {
        // Still loading (opened a moment ago): it may not have subscribed yet, so it pulls too.
        if (existing.webContents.isLoading()) pendingDashboardTarget = target;
        sendToWindow(existing, IPC.dashboardTarget, target);
      }
      if (droppedUrl && kind === "chat") {
        droppedUrlStore.set(droppedUrl);
        sendToWindow(existing, IPC.componentDroppedUrl, droppedUrl);
      }
      return;
    }
    // Defense-in-depth: with hide-on-close the avatar isn't destroyed in normal use, but never
    // call getBounds() on a destroyed window (it throws) — fall back to default placement.
    const anchor = avatar.isDestroyed() ? undefined : avatar.getBounds();
    const win = createComponentWindow(kind, anchor);
    trackComponentWindow(componentWindows, kind, win);
    if (kind === "chat") {
      win.on("close", (e) => {
        // First close attempt: hold the window open just long enough for the renderer to hand its
        // transcript to rememberOnClose (main extracts in the background — no review card) or
        // show the running-delegates Keep/Stop prompt, then re-issue the close via
        // allowChatClose. quitting/allowClose bypass it
        // so app-quit and the second close aren't blocked (safety-window-behavior: chat is its
        // own window, so this never touches avatar/intake).
        if (quitting || allowClose.has(win)) return;
        e.preventDefault();
        // trackComponentWindow's once("close") fired on this same cancelable close and dropped our
        // map entry; we're keeping the window open for that hand-off, so re-register it — otherwise
        // a reopen would spawn a second chat window instead of focusing this one.
        componentWindows.set(kind, win);
        sendToWindow(win, IPC.reviewBeforeClose, undefined);
      });
      // Captured now: the webContents is destroyed by the time `closed` fires.
      const clientId = win.webContents.id;
      win.on("closed", () => {
        host?.delegateTasks.cancelAll();
        host?.liveTasks.stopClient(clientId);
        host?.handlers.chat.releaseClient(clientId);
      });
    }
    if (droppedUrl && kind === "chat") {
      droppedUrlStore.set(droppedUrl);
      sendToWindow(win, IPC.componentDroppedUrl, droppedUrl);
    }
    if (target) pendingDashboardTarget = target;
  };
  // A live/delegate bubble's click: bring up the chat window on the chat that owns the task. A
  // freshly opened window has no such mount (its tasks died with the old one), so it just opens.
  ipcMain.on(IPC.openChatMount, (_e, mountId: unknown) => {
    if (typeof mountId !== "string") return;
    openComponent("chat");
    push.send(mountId, IPC.showChatMount, mountId);
  });
  // "Run skill" (Skills panel) is the only caller of window.bean.proposeRun() — it opens the
  // single-purpose Plan popup (just the proposal card), not the multi-turn Chat window.
  // The plan is both stored (pulled by the fresh window on mount — race-proof) and pushed
  // (updates an already-open window). See buildPlanStore for why the pull path exists.
  const planStore = buildPlanStore();
  const proposeRun = (suggestion: RouteSuggestion): void => {
    planStore.set(suggestion);
    openComponent("plan");
    sendToWindow(componentWindows.get("plan")!, IPC.proposeRun, suggestion);
  };
  const planFromDrop = (skillName: string, droppedUrl: string): void => {
    void (async () => {
      const [skills, projects] = await Promise.all([
        loadLayeredSkills(skillsDir(projectDir), skillsDir(dir)),
        loadProjects(projectsFile(dir)),
      ]);
      const suggestion = planForDroppedSkill(skillName, droppedUrl, skills, projects);
      planStore.set(suggestion);
      openComponent("plan");
      sendToWindow(componentWindows.get("plan")!, IPC.proposeRun, suggestion);
    })();
  };

  // Chat-target skill runs: stash the composed prompt (pull-on-mount, same race fix as
  // planStore) and open/focus the chat window; an already-mounted chat also gets the push.
  const chatPromptStore = buildChatPromptStore();
  const interruptedRunStore = buildInterruptedRunStore();
  const pendingUpdateStore = buildPendingUpdateStore();
  const runInChat = (payload: ChatPromptPayload): void => {
    chatPromptStore.set(payload);
    openComponent("chat");
    sendToWindow(componentWindows.get("chat")!, IPC.chatPrompt, payload);
  };

  const themePath = themeFile(app.getPath("userData"));
  const systemTheme = (): Theme => (nativeTheme.shouldUseDarkColors ? "graphite" : "hearth");
  let currentTheme: Theme = systemTheme();
  const getCurrentTheme = (): Theme => currentTheme;
  const setCurrentTheme = async (theme: Theme): Promise<void> => {
    currentTheme = theme;
    await saveTheme(themePath, theme);
  };

  // Tie the in-app theme to the OS light/dark setting: whenever the system
  // appearance changes, follow it live (the manual toggle still works, but a
  // later system change will win the next time the OS setting flips).
  nativeTheme.on("updated", () => {
    const next = systemTheme();
    if (next === currentTheme) return;
    currentTheme = next;
    push.broadcast(IPC.themeChanged, next);
  });

  // Desktop notifications: reminders, sprout digests and alarms (the host's `notification`).
  const shownNotifications = new Set<Notification>();
  const notificationTransport: Transport = {
    name: "notification",
    available: () => Notification.isSupported(),
    send: (msg) => {
      const n = new Notification({ title: msg.title ?? "Bean", body: msg.body });
      const opens = notificationOpens(msg.meta);
      const release = (): void => { shownNotifications.delete(n); };
      n.on("click", () => { release(); openComponent(opens.kind, opens.target); });
      n.on("close", release);
      // Electron drops a garbage-collected Notification's click handler, so a click hours later
      // would do nothing. ponytail: keep the newest 20 (`close` isn't guaranteed to fire); an
      // older one's click just activates Bean.
      shownNotifications.add(n);
      if (shownNotifications.size > 20) shownNotifications.delete(shownNotifications.values().next().value!);
      n.show();
    },
  };
  // Request macOS's notification permission on first launch instead of waiting for it to
  // fire implicitly on the first reminder. Electron has no Notification.requestPermission() —
  // the OS prompt only appears the first time a Notification is actually constructed/shown —
  // so fire one once, ever (tracked via notificationPermissionFile), rather than on every launch.
  const notifPermissionPath = notificationPermissionFile(app.getPath("userData"));
  const memoryNoticePath = join(app.getPath("userData"), "auto-memory-notice.json");
  void (async () => {
    if (!Notification.isSupported()) return;
    if (await hasRequestedNotificationPermission(notifPermissionPath)) return;
    new Notification({ title: "Bean", body: "Notifications are on — I'll use these for reminders." }).show();
    await markNotificationPermissionRequested(notifPermissionPath);
  })();

  try {
    // Chat windows' terminals die with their chat: release (incl. the window's `closed`, which
    // releases every chat it held), before-quit, and the update relaunch below. Created after the
    // host (it needs projectAllowed); a chat released before then has no terminals.
    let terminalTasks: TerminalTasks | undefined;
    const isChatClient = (clientId: number): boolean => componentWindows.get("chat")?.webContents.id === clientId;
    // The Electron-free host: chats, delegates, live sessions, routines + scheduler, memory (@bean/host).
    const h = host = await createHost({
      dir,
      builtinDir: projectDir,
      push: hostPush(push),
      onJobs: (jobs) => {
        keepAwake.setJobs(jobs); // before the avatar check: the hold must track work even without a window
        // Mid-reload the old document is gone; the finished reload replays the current list.
        if (!avatarControls.reloading()) push.broadcast(IPC.taskStatus, jobs);
      },
      notification: notificationTransport,
      isChatClient,
      onQuit: (fn) => app.on("before-quit", fn),
      // One-time heads-up the first time memory saves itself (same one-shot flag-file shape as the
      // notification-permission prompt).
      firstAutoMemory: async () => {
        const first = !(await hasRequestedNotificationPermission(memoryNoticePath));
        if (first) await markNotificationPermissionRequested(memoryNoticePath);
        return first;
      },
      onChatRelease: (mountId) => { void terminalTasks?.stopMount(mountId); }, // never rejects; the entry is held until the shell is gone
      bots: {
        root: app.isPackaged ? process.resourcesPath : dirname(projectBeanDir()),
        ...(app.isPackaged ? { serverEntries: { discord: "chatops/discord/server.js", teams: "chatops/teams/server.js" } } : {}),
        // Where the enabled set lived before the host owned it; copied into ~/.bean once.
        legacyEnabledFile: join(app.getPath("userData"), "chatops-enabled.json"),
        onEvent: (event) => {
          if (event.error) chatopsErrorSince[event.bot] = Date.now(); else delete chatopsErrorSince[event.bot];
          push.broadcast(IPC.chatopsEvent, event);
        },
        // Synced chats (synced-chats.ts): re-read the sidebar.
        onSynced: (e) => push.broadcast(IPC.syncedChatEvent, e),
      },
    });
    const { runtime } = h;

    // node-pty is loaded on first use, not at boot: a broken native module fails that terminal's
    // start, never the whole app. Packaged, it resolves from app.asar (spawn-helper unpacked).
    const requireNative = createRequire(import.meta.url);
    const spawnPty: PtyFactory = (file, args, opts) => (requireNative("node-pty") as typeof import("node-pty")).spawn(file, args, opts);
    const terminals = terminalTasks = createTerminalTasks({
      spawn: spawnPty,
      projectAllowed: h.projectAllowed,
      scratchPath: scratchDir(dir),
      send: (event) => push.send(event.mountId, IPC.terminalEvent, event),
    });
    killAllTerminals = terminals.killAll;

    registerIpc(ipcMain, {
      host: h.handlers,
      push,
      // In-process host on this Mac: everything; off macOS there's no Terminal.app or system controls.
      handshake: buildHandshake(pkg.version, process.platform, process.platform === "darwin"
        ? ["systemControls", "terminalHandoff", "pty", "pathOpen"] : ["pty", "pathOpen"]),
      shell: createShellOps(),
      terminalTasks: terminals,
      isChatClient,
      onLaunchError: (req, err) => {
        const label = req.mode === "open" ? "open the project in your editor" : `launch (${req.mode})`;
        dialog.showErrorBox("Bean", `Couldn't ${label}: ${err.message}`);
      },
      getTerminalApp: () => runtime.getTerminalApp(),
      getEditorApp: () => runtime.getEditorApp(),
      getAvailableClis: h.enabledClis,
      getCliModels: () => h.cliModels,
      beanDirPath: dir,
      getAppInfo: () => ({
        version: pkg.version,
        author: pkg.author,
        description: pkg.description,
        isPackaged: app.isPackaged,
      }),
      currentVersion: pkg.version,
      isPackaged: app.isPackaged,
      checkAndDownloadUpdate: (currentVersion: string) => checkAndDownloadUpdate(currentVersion),
      // The install ends in app.relaunch() + app.exit(), which skips before-quit — so the only
      // thing that would reap the chatops children is each server's 5s exitWhenOrphaned() poll,
      // and the replacement app can autostart Teams inside that window and lose the port to the
      // orphan. Kill them ourselves instead, while we still have handles.
      //
      // Hung off the relaunch hook rather than done up front on purpose: installAndRelaunch()
      // reaches relaunch() only after the bundle swap has succeeded (every failure path rolls
      // back and throws first — see updater.test.ts), and exit() is the very next statement. A
      // failed install therefore leaves the bots running and untouched, instead of killing them
      // for an update that never happened and leaving the toggles showing Stop. Live agent
      // sessions likewise: their permissions-bypassed trees must not outlive their chat window.
      installUpdate: (extractedAppPath: string) => installAndRelaunch(extractedAppPath, {
        relaunch: () => {
          h.bots.stopAll();
          h.liveTasks.forceKillAll();
          killAllTerminals();
          // exit() skips before-quit: release now, or the new app waits out the lease's TTL.
          h.schedulerLease.stop();
          app.relaunch();
        },
      }),
      pendingUpdateStore,
      cleanupExtractedBundle: (extractedAppPath: string) => cleanupExtractedBundle(extractedAppPath),
      openReleasesPage: () => { void shell.openExternal("https://github.com/ScenK/Bean/releases"); },
      chatopsStatus: h.bots.status,
      chatopsStart: h.bots.start,
      chatopsStop: h.bots.stop,
      getCurrentTheme, setCurrentTheme, openComponent, proposeRun, planFromDrop,
      getPendingPlan: planStore.get,
      getPendingDroppedUrl: droppedUrlStore.get,
      getPendingDashboardTarget: () => { const t = pendingDashboardTarget; pendingDashboardTarget = undefined; return t; },
      runInChat,
      getPendingChatPrompt: chatPromptStore.get,
      getPendingInterruptedRunNotices: interruptedRunStore.get,
      syncedChatHandlers: buildSyncedChatHandlers({
        dbFile: dbFile(dir),
        owners: () => loadChatopsOwners(dir),
        listConversations: listChatopsConversations,
        conversationTurns: chatopsConversationTurns,
        liveIds: h.bots.liveIds,
        deskTurn: h.bots.deskTurn,
        deskResume: h.bots.deskResume,
      }),
      deskContinue: buildDeskContinueHandler({
        listDestinations: () => listDestinations(dbFile(dir)),
        deskContinue: (body) => h.bots.deskContinue("discord", body),
        handover: (owner, sessionId) => h.liveTasks.handover(owner, sessionId),
      }),
    });

    await loadAvatarWindow(avatar);
    avatarReady = true;

    // Report any delegate run interrupted by the previous quit (delegate-tasks.ts's
    // interruptAll()/main.ts's own before-quit handler leave one outbox notice per run). A
    // one-shot claim, not a poll loop: main.ts is the only possible producer for the "chat"
    // transport, and only while it's dying — see .memory/project-durable-run-queue.md.
    const chatNotices = await claimOutbox(outboxDir(dir), "chat");
    for (const m of chatNotices) await ackOutbox(outboxDir(dir), m);
    if (chatNotices.length > 0) {
      const notices = chatNotices.map((m) => ({ text: m.body, display: m.displayBody ?? m.body }));
      interruptedRunStore.set(notices);
      openComponent("chat");
      const chat = componentWindows.get("chat");
      if (chat) sendToWindow(chat, IPC.interruptedRunNotice, notices);
    }
  } catch (err) {
    if (!avatarReady) throw err;
    dialog.showErrorBox("Bean", err instanceof Error ? err.message : String(err));
  }
}).catch((err: unknown) => {
  dialog.showErrorBox("Bean could not start", err instanceof Error ? err.message : String(err));
  app.quit();
});

ipcMain.on(IPC.quit, () => app.quit());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
