import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join, dirname } from "node:path";
import { chatopsEnabledFile, loadChatopsEnabled, saveChatopsEnabled } from "./chatops-enabled-store.js";
import { createChatopsServers } from "./chatops-servers.js";
import type { ChatopsBot, ChatopsState } from "./chatops-servers.js";
import { chatopsMenuRows } from "./chatops-tray-menu.js";
import { applyChatopsActivity, clearBotJobs } from "./chatops-activity.js";
import { installAvatarControls } from "./avatar-window.js";
import { app, ipcMain, dialog, BrowserWindow, type Rectangle, nativeTheme, Notification, Tray, Menu, nativeImage, shell, powerSaveBlocker, webContents } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import {
  beanDir, ensurePrivateBeanDir, configFile, projectsFile, skillsDir, personaFile, projectBeanDir, dbFile, remindersFile,
  isValidSessionId, resumeCommand, listSkillProposals, pruneStepAttempts, listStepAttempts, CLI_NAMES,
  modelMemoryFile, loadCliModels, clisFile, type CliModels,
  loadConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona, saveConfig,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill, loadMemories, appendMemories, updateMemory, deleteMemories, extractMemories,
  maybeDream, getMemoryMeta, restoreDreamRun, dreamDetails, type DreamDigest,
  loadReminders, updateReminders, fireDueReminders, enqueueOutbox, type Reminder, extractPageText,
  loadNotes, saveNote, archiveNote, restoreNote, purgeNote, starNote, loadNoteHistory, saveNoteImage, loadNoteImage, searchNotes, retrieveNoteTool, detectClis, loginShellPath, resolveCliPath, deliver,
  loadRoutines, saveRoutine, deleteRoutine, loadRoutineStates, saveRoutineStates,
  routinesDir, routineStateFile, outboxDir, claimOutbox, ackOutbox, runDelegate, killAllDelegates, killAllCommands,
  scratchDir, ROUTINE_STEP_TIMEOUT_MS, systemControlTool, imagesDir, makeOpenAIImageGen,
  addTodo, claimTodo, listTodos, listAllTodos, editTodoText, deleteTodo, reorderTodo, clearFinishedTodos, retryTodo,
  recoverInterruptedTodos, deleteTodosForRoutine, sweepDeadRuns,
  pollWatch, isWatchSeeded, seedWatch, markNewItems, unseenIds, clearWatch, watchSourceKey, briefMessages, parseBrief,
  availableModels, pinnedStepSelection, isLiveCli, findDelegateRun, saveDesktopChat, getDesktopChat, deleteDesktopChat, listDesktopChats,
  createRoutineScheduler, createRoutineHost, makeRoutineSteps, detectTools, execWatchCommand, fetchText, sinkRecipients, safeFetch,
} from "@bean/core";
import type { RouteSuggestion, ActionTool, Transport, CliName } from "@bean/core";
import { createAvatarWindow, loadAvatarWindow, createComponentWindow } from "./windows.js";
import {
  registerIpc, buildPlanStore, buildDroppedUrlStore, buildChatPromptStore, buildInterruptedRunStore, notificationOpens,
  buildRoutineHandlers, buildSkillProposalHandlers, buildTodoHandlers, buildPendingUpdateStore, buildChatThreadHandlers, type ChatPromptPayload,
} from "./ipc.js";
import { IPC, type Theme, type ComponentKind, type DashboardTarget } from "./channels.js";
import { saveTheme, themeFile } from "./theme-store.js";
import {
  hasRequestedNotificationPermission, markNotificationPermissionRequested, notificationPermissionFile,
} from "./notification-permission-store.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { sendToWindow, trackComponentWindow } from "./component-window-registry.js";
import { createDelegateTasks, resolveDelegateSelection, resolvedPathSpawnFn } from "./delegate-tasks.js";
import { createLiveTasks, LIVE_AGENT_NAMES } from "./live-tasks.js";
import { createRoutineBuilder } from "./routine-builder.js";
import { createTaskStatus } from "./task-status.js";
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
  const avatarControls = installAvatarControls(avatar);
  // Keep the Mac awake while Bean works, or always if the tray toggle is on (#188).
  const keepAwake = createKeepAwake({
    start: (type) => powerSaveBlocker.start(type),
    stop: (id) => powerSaveBlocker.stop(id),
    onChange: (held) => tray?.setToolTip(keepAwakeTooltip(held)),
  });
  // What Bean is working on, and what failed — pushed to the avatar's status bubbles (design 2a).
  const taskStatus = createTaskStatus((jobs) => {
    keepAwake.setJobs(jobs); // before the avatar check: the hold must track work even without a window
    if (!avatar.isDestroyed()) avatar.webContents.send(IPC.taskStatus, jobs);
  });
  ipcMain.on(IPC.dismissTask, (_e, id: unknown) => { if (typeof id === "string") taskStatus.dismiss(id); });
  // One local chat turn at a time (one chat window), so image progress can find its bubble.
  let chatTurnId: string | undefined;
  let avatarReady = false;
  // Hoisted out of the `try` block below (where it's created) so the tray menu's click
  // handler — built further up in this function, long before that `try` runs — can read
  // it. Safe because click handlers only fire on user interaction, after this whole
  // whenReady() callback (including the try block) has finished running.
  let chatopsServers: ReturnType<typeof createChatopsServers> | undefined;
  // Mirrors SettingsWindow.tsx's scheduleErrorClear (same 3s window): a tray-only cache of when
  // each bot's current error first appeared, so the submenu can stop showing a stale error even
  // though chatopsServers' own state (shared with Settings) keeps it until overwritten. Updated
  // by the `send` callback below; read by buildChatopsSubmenu's displayState.
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
  // row per bot. Mirrors SettingsWindow.tsx's own Start/Stop toggle — same chatopsServers
  // object, so both surfaces stay in sync. Rebuilt fresh in buildTrayMenu() below (not just
  // once here) so the checkbox/dot state is current every time the tray menu opens.
  const buildChatopsSubmenu = (): MenuItemConstructorOptions[] => {
    const rawStatus = chatopsServers?.status() ?? { discord: { running: false, enabled: false }, teams: { running: false, enabled: false } };
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
          row.checked ? chatopsServers?.stop(row.bot) : chatopsServers?.start(row.bot);
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

  // Reassigned once delegateTasks exists (below); a quit requested before that point has
  // nothing in-flight to interrupt, so the no-op default is correct, not just a placeholder.
  // Synchronous (see delegate-tasks.ts's interruptAll doc comment) — deliberately NOT a
  // preventDefault()-then-requeue dance: Electron's before-quit is known flaky around terminal
  // signals on this menu-bar/tray app already (see the SIGINT/SIGTERM handlers above), and
  // blocking the quit sequence on an async continuation is its own source of hangs. Every other
  // before-quit hook in this file is plain synchronous fire-and-forget; this matches that.
  let interruptAllDelegates: () => void = () => {};
  let forceKillLive: () => void = () => {};
  app.on("before-quit", () => {
    interruptAllDelegates();
    // Live agent sessions run permissions-bypassed in their own process groups: SIGKILL every
    // tree now (no outbox notice — the next boot's sweepDeadRuns clears their records silently).
    forceKillLive();
    // Delegates run in their own process group (detached) and would outlive us — routine steps
    // and builder agents included, and so do routine command steps. SIGKILL them now; cancel()'s
    // 5s escalation can't fire after exit.
    killAllDelegates();
    killAllCommands();
    // Spawned chatops servers do NOT die with us — without this they survive as launchd-owned
    // orphans, holding port 3978 and answering webhooks with whatever build they booted with.
    // The servers' own exitWhenOrphaned() watchdog covers the paths that never reach here
    // (crash, force-quit, SIGKILL).
    chatopsServers?.stopAll();
  });
  const allowClose = new WeakSet<BrowserWindow>();
  ipcMain.on(IPC.allowChatClose, (evt) => {
    const w = BrowserWindow.fromWebContents(evt.sender);
    if (!w) return;
    allowClose.add(w);
    if (!w.isDestroyed()) w.close();
  });

  const componentWindows = new Map<ComponentKind, BrowserWindow>();
  let cancelAllDelegates: () => void = () => {};
  let stopLiveOwner: (ownerId: number) => void = () => {};
  // Same drop-race fix as planStore below: a URL dropped on the avatar can reach a chat window
  // whose renderer hasn't mounted (and subscribed to componentDroppedUrl) yet, silently losing
  // the push. droppedUrlStore.get() is stashed alongside every push so the renderer can pull it
  // on mount instead.
  const droppedUrlStore = buildDroppedUrlStore();
  // A run to open in the Dashboard: pulled on mount by a fresh (or still-loading) window, pushed to
  // an open one. A mounted window never stores it — that would make a later reopen jump to an old run.
  let pendingDashboardTarget: DashboardTarget | undefined;
  // Desktop chat history: built here (not with the other handlers) because the chat window's
  // `closed` hands a sidebar switch to the next window.
  const chatThreadHandlers = buildChatThreadHandlers({ dbFile: dbFile(dir), saveDesktopChat, getDesktopChat, deleteDesktopChat, listDesktopChats });
  const openComponent = (kind: ComponentKind, payload?: string | DashboardTarget, bounds?: Rectangle): void => {
    const droppedUrl = typeof payload === "string" ? payload : undefined;
    const target = typeof payload === "object" && kind === "dashboard" ? payload : undefined;
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
    const win = createComponentWindow(kind, anchor, bounds);
    trackComponentWindow(componentWindows, kind, win);
    if (kind === "chat") {
      // Where a sidebar switch reopens: the bounds at the real close (the window is gone at `closed`).
      let lastBounds = win.getBounds();
      win.on("close", (e) => {
        // First close attempt: hold the window open just long enough for the renderer to hand its
        // transcript to rememberOnClose (main extracts in the background — no review card) or
        // show the running-delegates Keep/Stop prompt, then re-issue the close via
        // allowChatClose. quitting/allowClose bypass it
        // so app-quit and the second close aren't blocked (safety-window-behavior: chat is its
        // own window, so this never touches avatar/intake).
        if (quitting || allowClose.has(win)) { lastBounds = win.getBounds(); return; }
        e.preventDefault();
        // trackComponentWindow's once("close") fired on this same cancelable close and dropped our
        // map entry; we're keeping the window open for that hand-off, so re-register it — otherwise
        // a reopen would spawn a second chat window instead of focusing this one.
        componentWindows.set(kind, win);
        sendToWindow(win, IPC.reviewBeforeClose, undefined);
      });
      // Captured now: the webContents is destroyed by the time `closed` fires.
      const ownerId = win.webContents.id;
      win.on("closed", () => {
        cancelAllDelegates();
        stopLiveOwner(ownerId);
        // A sidebar switch: the next chat takes this one's place and pulls the picked thread.
        if (chatThreadHandlers.takeSwitch() && !quitting) openComponent("chat", undefined, lastBounds);
      });
    }
    if (droppedUrl && kind === "chat") {
      droppedUrlStore.set(droppedUrl);
      sendToWindow(win, IPC.componentDroppedUrl, droppedUrl);
    }
    if (target) pendingDashboardTarget = target;
  };
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
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };

  // Tie the in-app theme to the OS light/dark setting: whenever the system
  // appearance changes, follow it live (the manual toggle still works, but a
  // later system change will win the next time the OS setting flips).
  nativeTheme.on("updated", () => {
    const next = systemTheme();
    if (next === currentTheme) return;
    currentTheme = next;
    broadcast(IPC.themeChanged, next);
  });

  // Reminder action tools (executed by converse()'s tool loop) + a 30s poll that fires
  // due ones as desktop notifications. Polling the file means set_reminder never has to
  // wake a scheduler. ponytail: 30s granularity; tighten if minute-exact ever matters.
  const remindersPath = remindersFile(dir);
  // Message fanout: deliver() sends to every available() transport. Only Notification is
  // real today; the rest are honest stubs the routine feature will implement.
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

  // ponytail: stub seam — no avatar message-bubble UI exists yet. Add real IPC +
  // renderer rendering when the routine feature needs it.
  const bubbleTransport: Transport = { name: "bubble", available: () => false, send: () => {} };
  // ponytail: stub seams — bots are inbound-only, no main->bot outbound push path exists yet.
  // Build the main->server channel when the routine feature lands.
  const discordTransport: Transport = { name: "discord", available: () => false, send: () => {} };
  const teamsTransport: Transport = { name: "teams", available: () => false, send: () => {} };
  const transports: Transport[] = [notificationTransport, bubbleTransport, discordTransport, teamsTransport];
  const actionTools: ActionTool[] = [
    {
      spec: {
        name: "set_reminder",
        description: "Set a desktop-notification reminder for the user at a specific time.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "what to remind the user about" },
            at: { type: "string", description: "when to fire, as an ISO 8601 timestamp with timezone offset" },
          },
          required: ["text", "at"],
        },
      },
      run: async (args) => {
        const { text, at } = (args ?? {}) as { text?: unknown; at?: unknown };
        if (typeof text !== "string" || typeof at !== "string" || Number.isNaN(Date.parse(at))) {
          return "error: set_reminder needs { text, at } with `at` a valid ISO 8601 timestamp";
        }
        await updateReminders(remindersPath, (all) => { all.push({ id: randomUUID(), text, at }); });
        return `reminder saved for ${at}`;
      },
    },
    {
      spec: {
        name: "list_reminders",
        description: "List the user's pending (not yet fired) reminders.",
        parameters: { type: "object", properties: {} },
      },
      run: async () => {
        const pending = (await loadReminders(remindersPath)).filter((r) => !r.firedAt);
        return pending.length === 0 ? "no pending reminders" : JSON.stringify(pending);
      },
    },
    retrieveNoteTool((q) => searchNotes(dbFile(dir), q)),
  ];
  actionTools.push({
    spec: {
      name: "fetch_url",
      description:
        "Fetch a web page and return its readable text. Use whenever you need the actual " +
        "content behind an http(s) URL (summarizing, explaining, extracting from a page).",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "the http(s) URL to fetch" } },
        required: ["url"],
      },
    },
    run: async (args) => {
      const { url } = (args ?? {}) as { url?: unknown };
      let parsed: URL;
      try {
        parsed = new URL(typeof url === "string" ? url : "");
      } catch {
        return "error: fetch_url needs a valid absolute URL";
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `error: only http(s) URLs can be fetched, got ${parsed.protocol}`;
      }
      try {
        // safeFetch refuses loopback/LAN/metadata addresses (also after redirects) and caps the body.
        const res = await safeFetch(parsed.toString(), { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024 });
        if (!res.ok) return `error: fetch failed with HTTP ${res.status}`;
        const text = extractPageText(res.body);
        return text || "error: page had no readable text";
      } catch (err) {
        return `error: fetch failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Finder-launched Electron gets a minimal PATH missing whatever the user's shell profile
  // adds (nvm, npm/pnpm global bins, ~/.local/bin, ...) — ask the login shell for its real
  // PATH once. CLI detection is re-scanned per resolution (cheap sync stat) so a CLI
  // installed after boot is picked up without a relaunch.
  const resolvedPath = resolveCliPath(process.env.PATH ?? "", loginShellPath(), homedir());
  const detectedClis = (): CliName[] => detectClis(resolvedPath);

  // Same repo-default + ~/.bean override layering as skills/persona; loaded once at boot
  // (no live reload — restart Bean after editing clis.json).
  const cliModels: CliModels[] = await loadCliModels(clisFile(projectDir), clisFile(dir));

  // Chatops reminders (a `target`) go to the outbox for their bot (Discord / Teams) to deliver; untargeted
  // ones stay desktop notifications.
  const reminderFailed = (r: Reminder, err: unknown): void => {
    console.error("bean: reminder delivery failed", r.id, err);
    const why = err instanceof Error ? err.message : String(err);
    taskStatus.error("reminder:error", { kind: "reminder", name: "Reminder", line: `Couldn't deliver: ${r.text}`, detail: why });
  };
  setInterval(() => {
    fireDueReminders(remindersPath, new Date(), {
      untargeted: (r) => {
        void deliver({ body: r.text }, transports).then((outcomes) => {
          for (const o of outcomes) if (!o.ok) reminderFailed(r, `${o.name}: ${o.error instanceof Error ? o.error.message : String(o.error)}`);
        });
      },
      enqueue: (msg) => enqueueOutbox(outboxDir(dir), msg, randomUUID),
      failed: reminderFailed,
    }).catch((err: unknown) => console.error("bean: reminder loop failed", err));
  }, 30_000);

  try {
    const cfgPath = configFile(dir);
    // ponytail: first launch has no ~/.bean yet — bootstrap an empty-key config so
    // loadConfig (which throws on missing file) has something to read instead of crashing.
    if (!existsSync(cfgPath)) await saveConfig(cfgPath, { openaiApiKey: "", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, reasoningEffort: "" });
    const cfg = await loadConfig(cfgPath, dir);

    const runtime = createRuntimeConfig(
      { openaiApiKey: cfg.openaiApiKey, model: cfg.model, terminalApp: cfg.terminalApp, editorApp: cfg.editorApp, delegateCli: cfg.delegateCli, systemControls: cfg.systemControls, reasoningEffort: cfg.reasoningEffort, routineDigestContext: cfg.routineDigestContext, disabledClis: cfg.disabledClis, webSearch: cfg.webSearch, autoMemory: cfg.autoMemory },
      {
        makeChat: makeOpenAIChat,
        makeConverse: makeOpenAIConverse,
        saveConfigFile: (update) => saveConfig(configFile(dir), update),
      },
    );
    const enabledClis = (): CliName[] => detectedClis().filter((cli) => !runtime.getDisabledClis().includes(cli));
    // Gated per call on the live Settings toggle, so flipping it needs no restart.
    actionTools.push(systemControlTool(() => runtime.getSystemControls()));

    // Shared by createDelegateTasks (chat window's delegate button) and the routine
    // delegate-step adapter below — one resolver, not two copies of this preference logic.
    const resolveDelegateCli = (model?: string) =>
      resolveDelegateSelection(cliModels, enabledClis(), runtime.getDelegateCli(), model);

    const delegateTasks = createDelegateTasks({
      resolvedPath,
      dir,
      scratchPath: scratchDir(dir),
      resolveCli: resolveDelegateCli,
      skillBrowser: async (name) =>
        (await loadLayeredSkills(skillsDir(projectDir), skillsDir(dir))).find((s) => s.name === name)?.browser === true,
      send: (event) => {
        if (event.type === "started") {
          taskStatus.upsert(event.taskId, {
            kind: "delegate", name: event.projectPath ? basename(event.projectPath) : "delegate",
            line: "Starting…", detail: event.instruction, startedAt: Date.now(), state: "running",
          });
        } else if (event.type === "output") {
          const line = event.line.trim();
          if (line) taskStatus.upsert(event.taskId, { line });
        } else if (event.type === "done") taskStatus.finish(event.taskId, "done", "Done");
        else if (event.type === "failed") taskStatus.finish(event.taskId, "failed", event.message);
        else taskStatus.finish(event.taskId, "failed", "Stopped", false); // the user's own Stop isn't a failure to chase
        const chat = componentWindows.get("chat");
        if (chat && !chat.isDestroyed()) sendToWindow(chat, IPC.delegateEvent, event);
      },
      newId: () => randomUUID(),
    });
    cancelAllDelegates = delegateTasks.cancelAll;
    interruptAllDelegates = delegateTasks.interruptAll;

    const liveTasks = createLiveTasks({
      resolvedPath,
      dir,
      enabledClis,
      scratchPath: scratchDir(dir),
      findResumable: (sessionId) => findDelegateRun(dbFile(dir), sessionId, undefined, "desktop"),
      projectAllowed: async (path) =>
        path === scratchDir(dir) || (await loadProjects(projectsFile(dir))).some((p) => p.path === path),
      newId: () => randomUUID(),
      send: (ownerId, event) => {
        const id = `live:${event.sessionId}`;
        if (event.type === "started") {
          taskStatus.upsert(id, {
            kind: "live", agent: event.agent, name: `${LIVE_AGENT_NAMES[event.agent]} · ${basename(event.projectPath) || "scratch"}`,
            line: "Starting…", detail: event.projectPath, startedAt: Date.now(), state: "running",
          });
        } else if (event.type === "output") {
          const line = event.line.trim();
          if (line) taskStatus.upsert(id, { line });
        } else if (event.type === "turn") {
          taskStatus.upsert(id, { line: event.failed ? "Turn failed" : "Waiting for you" });
        } else if (event.type === "session") {
          // the receipt is for the chat window only
        } else if (event.reason === "failed") taskStatus.finish(id, "failed", event.error ?? "Session died");
        else taskStatus.finish(id, "done", event.reason === "stopped" ? "Session ended" : "Session ended on its own", false);
        const owner = webContents.fromId(ownerId);
        if (owner && !owner.isDestroyed()) owner.send(IPC.liveEvent, event);
      },
    });
    stopLiveOwner = liveTasks.stopOwner;
    forceKillLive = liveTasks.forceKillAll;

    const chatopsRoot = app.isPackaged ? process.resourcesPath : dirname(projectBeanDir());
    const chatopsEnabledPath = chatopsEnabledFile(app.getPath("userData"));
    let chatopsSave: Promise<void> = Promise.resolve();
    chatopsServers = createChatopsServers({
      repoRoot: chatopsRoot,
      resolvedPath,
      onActivity: (bot, e) => applyChatopsActivity(taskStatus, bot, e),
      send: (event) => {
        if (event.error) {
          chatopsErrorSince[event.bot] = Date.now();
          taskStatus.error(`bot:${event.bot}`, { kind: "bot", name: event.bot === "discord" ? "Discord" : "Teams", line: event.error, detail: event.error });
        } else delete chatopsErrorSince[event.bot];
        if (!event.running) clearBotJobs(taskStatus, event.bot);
        broadcast(IPC.chatopsEvent, event);
      },
      // Chained, not fire-and-forget: replaying two bots at boot (or a fast toggle) would
      // otherwise put two mkdir+writeFile calls on the same path in flight, where an older
      // subset can land last — or a torn write leaves JSON that loadChatopsEnabled() reads as
      // "nothing enabled", silently undoing autostart.
      onEnabledChange: (bots) => {
        chatopsSave = chatopsSave.then(() => saveChatopsEnabled(chatopsEnabledPath, bots)).catch(() => {});
      },
      ...(app.isPackaged ? {
        serverEntries: { discord: "chatops/discord/server.js", teams: "chatops/teams/server.js" },
        extraEnv: { BEAN_BUILTIN_DIR: projectDir },
      } : {}),
    });
    app.on("before-quit", () => chatopsServers?.stopAll());
    // Bring back whatever the user had switched on. Every restart path lands here — plain quit,
    // dev relaunch, and an update install (`app.relaunch()` skips before-quit, but each server's
    // exitWhenOrphaned() reaps it) — so the bots don't quietly stay off after an update.
    for (const bot of await loadChatopsEnabled(chatopsEnabledPath)) chatopsServers.start(bot);

    // --- Routines: cron-scheduled multi-step automations (see .memory/project-routines.md). ---
    const routinesPath = routinesDir(dir);
    const routineStatePath = routineStateFile(dir);

    // Anything stuck `running` was interrupted by the previous quit — fail it visibly (retryable).
    const recovered = await recoverInterruptedTodos(dbFile(dir));
    if (recovered > 0) console.warn(`bean: marked ${recovered} interrupted todo(s) as failed`);
    // Run records a crash left behind (run-queue.ts). Never kills: the bots share runs/.
    sweepDeadRuns(dir);

    // Delegate/command step adapters (core routine-steps.ts), on the same resolved login-shell
    // PATH spawn as delegate-tasks (safety-packaged-app-path-detection).
    const { delegateStep, commandStep } = makeRoutineSteps({
      dir,
      // A pinned harness refuses here, before any reservation or spawn — never a silent swap.
      selectCli: (req) => req.cli
        ? pinnedStepSelection({ cli: req.cli, model: req.model }, enabledClis(), availableModels(cliModels, enabledClis()))
        : resolveDelegateCli(req.model),
      spawnFn: resolvedPathSpawnFn(resolvedPath),
      path: resolvedPath,
    });

    const { runOneRoutine, deliverDigest } = createRoutineHost({
      dir,
      converse: runtime.converse,
      getModel: () => runtime.getModel(),
      delegateStep,
      commandStep,
      tools: actionTools,
      loadSkills: () => loadLayeredSkills(skillsDir(projectDir), skillsDir(dir)),
      // Household-shared only: routines never see a member's private facts.
      memories: () => loadMemories(dbFile(dir), null),
      getRoutineDigestContext: () => runtime.getRoutineDigestContext(),
      onStatus: (e) => {
        if (e.type === "start") taskStatus.upsert(e.id, { kind: "routine", name: e.name, line: e.steps[0] ?? "", detail: e.detail, steps: e.steps, step: 0, startedAt: e.startedAt, state: "running", runStartedAt: undefined });
        else if (e.type === "step") taskStatus.upsert(e.id, { step: e.step, line: e.line });
        else taskStatus.finish(e.id, e.state, e.line, undefined, { runStartedAt: e.startedAt });
      },
      notify: async ({ target, ...msg }) => {
        if (notificationTransport.available()) await notificationTransport.send({ ...msg, ...(target ? { meta: { open: "dashboard", target } } : {}) });
      },
    });

    const watchPoll = { fetchText, exec: execWatchCommand(resolvedPath) };
    const routineScheduler = createRoutineScheduler({
      loadRoutines: () => loadRoutines(routinesPath),
      loadStates: () => loadRoutineStates(routineStatePath),
      saveStates: (s) => saveRoutineStates(routineStatePath, s),
      runRoutine: runOneRoutine,
      pruneAttempts: (r, keep) => pruneStepAttempts(dbFile(dir), r, keep),
      deliverDigest,
      hasPendingTodos: async (r) => (await listTodos(dbFile(dir), r)).some((t) => t.status === "pending"),
      claimTodo: (r) => claimTodo(dbFile(dir), r),
      pollWatch: (w) => pollWatch(w, watchPoll),
      watchSeen: {
        isSeeded: (r, source) => isWatchSeeded(dbFile(dir), r, source),
        seed: (r, source, ids) => seedWatch(dbFile(dir), r, source, ids),
        unseen: (r, ids) => unseenIds(dbFile(dir), r, ids),
        markNew: (r, ids) => markNewItems(dbFile(dir), r, ids),
      },
      addTodo: async (r, text) => { await addTodo(dbFile(dir), r, text); },
      saveRoutine: (r) => saveRoutine(routinesPath, r),
      alarm: (routine, error) => {
        if (notificationTransport.available()) {
          void notificationTransport.send({ title: `Sprout: ${routine.name}`, body: `Can't check for new items — ${error}`, meta: { open: "routines" } });
        }
      },
    });
    const tools = detectTools(resolvedPath);
    const routineBuilder = createRoutineBuilder({
      loadRoutines: () => loadRoutines(routinesPath),
      saveRoutine: (r) => saveRoutine(routinesPath, r),
      loadSkills: () => loadLayeredSkills(skillsDir(projectDir), skillsDir(dir)),
      saveSkill: (name, md) => saveSkill(skillsDir(dir), name, md),
      pollWatch: (w) => pollWatch(w, watchPoll),
      fetchText,
      tools: () => tools,
      // Not recorded in delegate_runs: the builder is internal tooling whose scratch session the
      // user never asked to revisit (see .memory/project-delegate-session-receipts.md).
      startAgent: (prompt, brief, onLine) => {
        const choice = resolveDelegateSelection(cliModels, enabledClis(), brief.builder?.cli ?? runtime.getDelegateCli(), brief.builder?.model);
        if (!choice) return { done: Promise.reject(new Error("No enabled delegate CLI found — enable one in Settings.")), cancel: () => {} };
        const cwd = join(scratchDir(dir), `build-${brief.name}`); // name validated kebab-case in builder.start
        mkdirSync(cwd, { recursive: true });
        let cancel = (): void => {};
        const done = new Promise<string>((resolve, reject) => {
          const cleanup = (): void => rmSync(cwd, { recursive: true, force: true });
          const handle = runDelegate(
            { cli: choice.cli, projectPath: cwd, prompt, ...(choice.model ? { model: choice.model } : {}) },
            { onOutput: onLine, onDone: (out) => { cleanup(); resolve(out); }, onError: (err) => { cleanup(); reject(err); } },
            resolvedPathSpawnFn(resolvedPath),
            ROUTINE_STEP_TIMEOUT_MS,
          );
          cancel = () => handle.cancel(cleanup);
        });
        return { done, cancel: () => cancel() };
      },
    });
    app.on("before-quit", () => routineBuilder.cancelAll());
    routineScheduler.start();
    app.on("before-quit", () => routineScheduler.stop());

    // Checked after each auto-save (close batch or per-turn capture) — no timer, no boot cost.
    // The digest goes to a bubble + Persona only, never into a transcript (it would be
    // re-extracted as a "fact").
    const checkDream = async (pendingIds: () => string[]): Promise<void> => {
      const dream = await maybeDream({
        dbFile: dbFile(dir), chat: runtime.converse, model: runtime.getModel(), exclude: pendingIds,
      });
      if (!dream) return;
      const parts = [
        dream.merged ? `merged ${dream.merged}` : "", dream.rewritten ? `rewrote ${dream.rewritten}` : "",
        dream.removed ? `removed ${dream.removed}` : "",
      ].filter(Boolean).join(", ");
      taskStatus.upsert("memory:dream", { kind: "memory", name: "Memory", startedAt: Date.now(), state: "running" });
      taskStatus.finish("memory:dream", "done", `🌙 Tidied memory: ${parts} · click to review`);
    };

    registerIpc(ipcMain, {
      loadSkills: loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona,
      loadMemories, appendMemories, updateMemory, deleteMemories, extractMemories, restoreDreamRun, dreamDetails,
      getLastDream: async (file) => (await getMemoryMeta(file, "lastDream")) as DreamDigest | undefined,
      autoMemory: () => runtime.getAutoMemory(),
      onTurnBatch: (pendingIds) => {
        checkDream(pendingIds).catch((err) => console.error("memory dream failed:", err));
      },
      onMemoryBatch: (batch, pendingIds) => {
        void (async () => {
          // One-time heads-up the first time memory saves itself (same one-shot flag-file shape
          // as the notification-permission prompt).
          const first = !(await hasRequestedNotificationPermission(memoryNoticePath));
          if (first) await markNotificationPermissionRequested(memoryNoticePath);
          const id = "memory:batch";
          taskStatus.upsert(id, { kind: "memory", name: "Memory", startedAt: Date.now(), state: "running" });
          taskStatus.finish(id, "done", first
            ? "I remember things automatically now · click to review or turn off"
            : `🧠 Remembered ${batch.length} · click to review`);
          await checkDream(pendingIds);
        })().catch((err) => console.error("memory bubble/dream failed:", err));
      },
      onMemoryFailure: () => taskStatus.error("memory:error", { kind: "memory", name: "Memory", line: "Couldn't update memory" }),
      loadNotes, saveNote, archiveNote, restoreNote, purgeNote, starNote, loadNoteHistory, saveNoteImage, loadNoteImage,
      dbFile: dbFile(dir),
      chat: runtime.chat,
      converse: runtime.converse,
      getModel: runtime.getModel,
      projectSkillsDir: skillsDir(projectDir),
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      personaFile: personaFile(dir),
      projectPersonaFile: personaFile(projectDir),
      actions: actionTools,
      imageGen: {
        generate: (a) => makeOpenAIImageGen(runtime.getApiKey())(a),
        // ponytail: imageModel read at boot; move into runtime-config if a Settings field ever exists
        getModel: () => cfg.imageModel,
        imagesDir: imagesDir(dir),
        saveNoteImage: (bytes) => saveNoteImage(dbFile(dir), bytes),
        onStart: () => {
          componentWindows.get("chat")?.webContents.send(IPC.chatImageProgress);
          if (chatTurnId) taskStatus.upsert(chatTurnId, { line: "Drawing an image…" });
        },
      },
      getConfig: () => ({
        openaiApiKey: runtime.getApiKey(),
        model: runtime.getModel(),
        terminalApp: runtime.getTerminalApp(),
        editorApp: runtime.getEditorApp(),
        delegateCli: runtime.getDelegateCli(),
        systemControls: runtime.getSystemControls(),
        reasoningEffort: runtime.getReasoningEffort(),
        routineDigestContext: runtime.getRoutineDigestContext(),
        disabledClis: runtime.getDisabledClis(),
        webSearch: runtime.getWebSearch(),
        autoMemory: runtime.getAutoMemory(),
        paths: {
          config: configFile(dir),
          skills: skillsDir(dir),
          projects: projectsFile(dir),
          persona: personaFile(dir),
        },
      }),
      applyConfig: (update) => runtime.apply(update),
      getTerminalApp: () => runtime.getTerminalApp(),
      getEditorApp: () => runtime.getEditorApp(),
      getAvailableClis: () => enabledClis(),
      getDetectedClis: detectedClis,
      getCliModels: () => cliModels,
      beanDirPath: dir,
      modelMemoryFile: modelMemoryFile(dir),
      delegateTasks,
      liveTasks,
      isChatSender: (sender) => componentWindows.get("chat")?.webContents === sender,
      delegateAvailable: () => enabledClis().length > 0,
      // A live CLI is enabled and this window has no agent session yet (#478).
      liveSessionAvailable: (senderId) => componentWindows.get("chat")?.webContents.id === senderId
        && enabledClis().some(isLiveCli) && !liveTasks.hasSession(senderId),
      webSearch: () => runtime.getWebSearch(),
      onChatTurn: () => {
        const id = `chat:${randomUUID()}`;
        chatTurnId = id;
        taskStatus.upsert(id, { kind: "chat", name: "Chat", line: "Thinking…", startedAt: Date.now(), state: "running" });
        return (error) => {
          if (chatTurnId === id) chatTurnId = undefined;
          // The reply is already in the chat window — a done bubble would only echo it.
          taskStatus.dismiss(id);
          if (error) taskStatus.error("chat:error", { kind: "chat", name: "Chat", line: error, detail: error });
        };
      },
      onLaunchError: (req, err) => {
        const label = req.mode === "open" ? "open the project in your editor" : `launch (${req.mode})`;
        dialog.showErrorBox("Bean", `Couldn't ${label}: ${err.message}`);
      },
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
          chatopsServers?.stopAll();
          forceKillLive();
          app.relaunch();
        },
      }),
      pendingUpdateStore,
      cleanupExtractedBundle: (extractedAppPath: string) => cleanupExtractedBundle(extractedAppPath),
      openReleasesPage: () => { void shell.openExternal("https://github.com/ScenK/Bean/releases"); },
      chatopsStatus: chatopsServers.status,
      chatopsStart: chatopsServers.start,
      chatopsStop: chatopsServers.stop,
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun, planFromDrop,
      getPendingPlan: planStore.get,
      getPendingDroppedUrl: droppedUrlStore.get,
      getPendingDashboardTarget: () => { const t = pendingDashboardTarget; pendingDashboardTarget = undefined; return t; },
      runInChat,
      getPendingChatPrompt: chatPromptStore.get,
      getPendingInterruptedRunNotices: interruptedRunStore.get,
      loadRoutines: () => loadRoutines(routinesPath),
      skillProposalHandlers: buildSkillProposalHandlers({
        loadSkills: loadLayeredSkills, projectSkillsDir: skillsDir(projectDir), skillsDir: skillsDir(dir), dbFile: dbFile(dir),
      }),
      routineHandlers: buildRoutineHandlers({
        loadRoutines: () => loadRoutines(routinesPath),
        // Model check only when enabling/enabled: pausing must never be blocked by a model that
        // has since left clis.json (the run itself refuses either way).
        saveRoutine: (r) => saveRoutine(routinesPath, r, r.enabled ? cliModels : undefined),
        deleteRoutine: (name) => deleteRoutine(routinesPath, name),
        loadStates: () => loadRoutineStates(routineStatePath),
        isRunning: (name) => routineScheduler.isRunning(name),
        runningCount: (name) => routineScheduler.runningCount(name),
        queueCounts: async (name) => {
          const todos = await listTodos(dbFile(dir), name);
          return { pending: todos.filter((t) => t.status === "pending").length, running: todos.filter((t) => t.status === "running").length };
        },
        runNow: (name) => routineScheduler.runNow(name),
        onRoutineDeleted: async (name) => {
          await deleteTodosForRoutine(dbFile(dir), name);
          clearWatch(dbFile(dir), name);
          pruneStepAttempts(dbFile(dir), name, []);
        },
        attempts: (runId) => listStepAttempts(dbFile(dir), runId).map((a) => ({
          stepIndex: a.stepIndex, round: a.round, kind: a.kind, ok: a.ok, output: a.output,
          ...(a.stepId ? { stepId: a.stepId } : {}), ...(a.cli ? { cli: a.cli } : {}), ...(a.verdict ? { verdict: a.verdict } : {}),
          ...(a.cli && a.sessionId && isValidSessionId(a.sessionId) && CLI_NAMES.includes(a.cli as CliName)
            ? { resume: resumeCommand(a.cli as CliName, a.sessionId) } : {}),
        })),
        watch: {
          isSeeded: (r) => (r.watch ? isWatchSeeded(dbFile(dir), r.name, watchSourceKey(r.watch)) : true),
          pollFailures: (name) => routineScheduler.pollFailures(name),
          checkNow: (name) => routineScheduler.checkNow(name),
          previewWatch: (w) => pollWatch(w, watchPoll),
          enableWatch: (name, queueExisting) => routineScheduler.enableWatch(name, queueExisting),
          sinkRecipients: () => sinkRecipients(dir),
          draftBrief: async (sentence, previous) => {
            const [skills, projects] = await Promise.all([
              loadLayeredSkills(skillsDir(projectDir), skillsDir(dir)), loadProjects(projectsFile(dir)),
            ]);
            const ctx = {
              tools,
              projects: projects.map((p) => ({ name: p.name, path: p.path })),
              skills: skills.filter((s) => !s.hidden && s.enabled !== false).map((s) => ({ name: s.name, description: s.description })),
              clis: enabledClis(),
            };
            // Plain structured-output call on /v1/responses with no tools — not a propose_* tool,
            // so converse()'s byte-stable tool list is untouched.
            const res = await runtime.converse({ model: runtime.getModel(), messages: briefMessages(sentence, ctx, previous), tools: [] });
            return { brief: parseBrief(res.content, ctx), tools };
          },
          builds: routineBuilder,
        },
      }),
      todoHandlers: buildTodoHandlers({
        dbFile: dbFile(dir),
        loadRoutines: () => loadRoutines(routinesPath),
        addTodo, listTodos, listAllTodos, editTodoText, deleteTodo, reorderTodo, clearFinishedTodos, retryTodo,
      }),
      chatThreadHandlers,
      closeChatWindow: () => componentWindows.get("chat")?.close(),
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
