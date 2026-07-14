import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createChatopsServers } from "./chatops-servers.js";
import type { ChatopsBot, ChatopsState } from "./chatops-servers.js";
import { chatopsMenuRows } from "./chatops-tray-menu.js";
import { app, ipcMain, dialog, BrowserWindow, nativeTheme, Notification, Tray, Menu, nativeImage, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile, projectBeanDir, dbFile, remindersFile,
  modelMemoryFile,
  loadConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona, saveConfig,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill, loadMemories, saveMemories, appendMemories, extractMemories,
  loadReminders, saveReminders, dueReminders, extractPageText,
  loadNotes, saveNote, deleteNote, searchNotes, retrieveNoteTool, detectClis, loginShellPath, deliver,
  loadRoutines, saveRoutine, deleteRoutine, loadRoutineStates, saveRoutineStates,
  routinesDir, routineStateFile, outboxDir, enqueueOutbox, claimOutbox, runRoutine, runDelegate,
  composePrompt, scratchDir, ROUTINE_STEP_TIMEOUT_MS,
} from "@bean/core";
import type { RouteSuggestion, ActionTool, Transport, DelegateStepRequest, Routine, RoutineRunResult } from "@bean/core";
import { createAvatarWindow, createComponentWindow } from "./windows.js";
import {
  registerIpc, buildPlanStore, buildDroppedUrlStore, buildChatPromptStore, buildInterruptedRunStore,
  buildRoutineHandlers, buildPendingUpdateStore, type ChatPromptPayload,
} from "./ipc.js";
import { IPC, type Theme, type ComponentKind } from "./channels.js";
import { saveTheme, themeFile } from "./theme-store.js";
import {
  hasRequestedNotificationPermission, markNotificationPermissionRequested, notificationPermissionFile,
} from "./notification-permission-store.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { sendToWindow, trackComponentWindow } from "./component-window-registry.js";
import { createDelegateTasks, resolvedPathSpawnFn } from "./delegate-tasks.js";
import { createRoutineScheduler } from "./routine-scheduler.js";
import { checkAndDownloadUpdate, installAndRelaunch } from "./updater.js";

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

app.whenReady().then(async () => {
  const dir = beanDir();
  // Packaged builds don't contain the monorepo root, so projectBeanDir()'s "../../../.bean"
  // walk resolves outside the app bundle. electron-builder copies .bean into Resources/builtin
  // instead (see package.json build.extraResources) — use that when packaged.
  const projectDir = app.isPackaged ? join(process.resourcesPath, "builtin") : projectBeanDir();

  const avatar = createAvatarWindow();
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
    if (!avatar.isDestroyed()) { avatar.show(); avatar.focus(); }
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
    const rawStatus = chatopsServers?.status() ?? { discord: { running: false }, teams: { running: false } };
    // Drop an error once it's past CHATOPS_ERROR_DISPLAY_MS old — see chatopsErrorSince above.
    const displayState = (bot: ChatopsBot, s: ChatopsState): ChatopsState => {
      const since = chatopsErrorSince[bot];
      const stale = s.error && since !== undefined && Date.now() - since > CHATOPS_ERROR_DISPLAY_MS;
      return stale ? { running: s.running } : s;
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
        click: () => (row.checked ? chatopsServers?.stop(row.bot) : chatopsServers?.start(row.bot)),
      });
      if (row.error) items.push({ label: `⚠️ ${row.error}`, enabled: false });
    }
    return items;
  };
  const buildTrayMenu = (): Menu => Menu.buildFromTemplate([
    { label: "Settings", icon: symbol("gearshape"), accelerator: "Cmd+,", click: () => openComponent("settings") },
    { label: "Chat Bots", icon: symbol("message"), submenu: buildChatopsSubmenu() },
    { label: "Persona", icon: symbol("person.crop.circle"), accelerator: "Cmd+P", click: () => openComponent("persona") },
    { label: "About", icon: symbol("info.circle"), click: () => openComponent("about") },
    { label: "Exit", icon: symbol("rectangle.portrait.and.arrow.right"), accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
  let trayMenu = buildTrayMenu();
  tray = new Tray(trayIcon);
  if (trayIcon.isEmpty()) tray.setTitle("🫘");
  tray.setToolTip("Bean");
  // A hidden avatar (tucked away by Cmd+W) is re-summoned by the first tray click; when the
  // bean is already visible, the click pops the menu as usual.
  tray.on("click", () => {
    if (!avatar.isDestroyed() && !avatar.isVisible()) {
      avatar.show();
      avatar.focus();
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
    if (!avatar.isDestroyed() && !avatar.isVisible()) { avatar.show(); avatar.focus(); }
  });

  let quitting = false;
  // Reassigned once delegateTasks exists (below); a quit requested before that point has
  // nothing in-flight to interrupt, so the no-op default is correct, not just a placeholder.
  // Synchronous (see delegate-tasks.ts's interruptAll doc comment) — deliberately NOT a
  // preventDefault()-then-requeue dance: Electron's before-quit is known flaky around terminal
  // signals on this menu-bar/tray app already (see the SIGINT/SIGTERM handlers above), and
  // blocking the quit sequence on an async continuation is its own source of hangs. Every other
  // before-quit hook in this file is plain synchronous fire-and-forget; this matches that.
  let interruptAllDelegates: () => void = () => {};
  app.on("before-quit", () => {
    quitting = true;
    interruptAllDelegates();
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
  // Same drop-race fix as planStore below: a URL dropped on the avatar can reach a chat window
  // whose renderer hasn't mounted (and subscribed to componentDroppedUrl) yet, silently losing
  // the push. droppedUrlStore.get() is stashed alongside every push so the renderer can pull it
  // on mount instead.
  const droppedUrlStore = buildDroppedUrlStore();
  const openComponent = (kind: ComponentKind, droppedUrl?: string): void => {
    const existing = componentWindows.get(kind);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
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
        // First close attempt: hold the window open, let the renderer extract + confirm
        // memories, then re-issue the close via allowChatClose. quitting/allowClose bypass it
        // so app-quit and the second close aren't blocked (safety-window-behavior: chat is its
        // own window, so this never touches avatar/intake).
        if (quitting || allowClose.has(win)) return;
        e.preventDefault();
        // trackComponentWindow's once("close") fired on this same cancelable close and dropped our
        // map entry; we're keeping the window open for the memory review, so re-register it — otherwise
        // a reopen would spawn a second chat window instead of focusing this one.
        componentWindows.set(kind, win);
        sendToWindow(win, IPC.reviewBeforeClose, undefined);
      });
      win.on("closed", () => cancelAllDelegates());
    }
    if (droppedUrl && kind === "chat") {
      droppedUrlStore.set(droppedUrl);
      sendToWindow(win, IPC.componentDroppedUrl, droppedUrl);
    }
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
  const notificationTransport: Transport = {
    name: "notification",
    available: () => Notification.isSupported(),
    send: (msg) => {
      const n = new Notification({ title: msg.title ?? "Bean", body: msg.body });
      n.on("click", () => openComponent("chat"));
      n.show();
    },
  };
  // Request macOS's notification permission on first launch instead of waiting for it to
  // fire implicitly on the first reminder. Electron has no Notification.requestPermission() —
  // the OS prompt only appears the first time a Notification is actually constructed/shown —
  // so fire one once, ever (tracked via notificationPermissionFile), rather than on every launch.
  const notifPermissionPath = notificationPermissionFile(app.getPath("userData"));
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
        const reminders = await loadReminders(remindersPath);
        reminders.push({ id: randomUUID(), text, at });
        await saveReminders(remindersPath, reminders);
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
        const res = await fetch(parsed, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return `error: fetch failed with HTTP ${res.status}`;
        const text = extractPageText(await res.text());
        return text || "error: page had no readable text";
      } catch (err) {
        return `error: fetch failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // PATH doesn't change mid-session — detect once, serve from cache. Finder-launched
  // Electron gets a minimal PATH missing whatever the user's shell profile adds (nvm,
  // npm/pnpm global bins, ~/.local/bin, ...) — ask the login shell for its real PATH.
  const resolvedPath = [process.env.PATH ?? "", loginShellPath(), "/opt/homebrew/bin", "/usr/local/bin"].join(":");
  const availableClis = detectClis(resolvedPath);

  setInterval(() => {
    void (async () => {
      const reminders = await loadReminders(remindersPath);
      const due = dueReminders(reminders, new Date());
      if (due.length === 0) return;
      const firedAt = new Date().toISOString();
      for (const r of due) {
        void deliver({ body: r.text }, transports).then((outcomes) => {
          for (const o of outcomes) if (!o.ok) console.error("bean: deliver failed", o.name, o.error);
        });
        r.firedAt = firedAt;
      }
      await saveReminders(remindersPath, reminders);
    })();
  }, 30_000);

  try {
    const cfgPath = configFile(dir);
    // ponytail: first launch has no ~/.bean yet — bootstrap an empty-key config so
    // loadConfig (which throws on missing file) has something to read instead of crashing.
    if (!existsSync(cfgPath)) await saveConfig(cfgPath, { openaiApiKey: "", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" });
    const cfg = await loadConfig(cfgPath, dir);

    const runtime = createRuntimeConfig(
      { openaiApiKey: cfg.openaiApiKey, model: cfg.model, terminalApp: cfg.terminalApp, editorApp: cfg.editorApp, delegateCli: cfg.delegateCli },
      {
        makeChat: makeOpenAIChat,
        makeConverse: makeOpenAIConverse,
        saveConfigFile: (update) => saveConfig(configFile(dir), update),
      },
    );

    // Shared by createDelegateTasks (chat window's delegate button) and the routine
    // delegate-step adapter below — one resolver, not two copies of this preference logic.
    const resolveDelegateCli = (): (typeof availableClis)[number] | undefined => {
      const preferred = runtime.getDelegateCli();
      if ((preferred === "claude" || preferred === "opencode") && availableClis.includes(preferred)) return preferred;
      return availableClis[0];
    };

    const delegateTasks = createDelegateTasks({
      resolvedPath,
      dir,
      resolveCli: resolveDelegateCli,
      send: (event) => {
        const chat = componentWindows.get("chat");
        if (chat && !chat.isDestroyed()) sendToWindow(chat, IPC.delegateEvent, event);
      },
      newId: () => randomUUID(),
    });
    cancelAllDelegates = delegateTasks.cancelAll;
    interruptAllDelegates = delegateTasks.interruptAll;

    const chatopsRoot = app.isPackaged ? process.resourcesPath : dirname(projectBeanDir());
    chatopsServers = createChatopsServers({
      repoRoot: chatopsRoot,
      resolvedPath,
      send: (event) => {
        if (event.error) chatopsErrorSince[event.bot] = Date.now(); else delete chatopsErrorSince[event.bot];
        broadcast(IPC.chatopsEvent, event);
      },
      ...(app.isPackaged ? {
        serverEntries: { discord: "chatops/discord/server.js", teams: "chatops/teams/server.js" },
        extraEnv: { BEAN_BUILTIN_DIR: projectDir },
      } : {}),
    });
    app.on("before-quit", () => chatopsServers?.stopAll());

    // --- Routines: cron-scheduled multi-step automations (see .memory/project-routines.md). ---
    const routinesPath = routinesDir(dir);
    const routineStatePath = routineStateFile(dir);

    // Delegate step adapter: runDelegate's callback shape → a promise, prior outputs folded
    // into the prompt, scratch workspace when the step has no project. Reuses the same
    // resolved login-shell PATH spawn as delegate-tasks (safety-packaged-app-path-detection)
    // and enforces the 15-minute routine step timeout explicitly (runDelegate's own default
    // is 30 minutes, meant for the interactive chat delegate button, not routines).
    const delegateStep = (req: DelegateStepRequest): Promise<string> =>
      new Promise((resolve, reject) => {
        const cli = resolveDelegateCli();
        if (!cli) { reject(new Error("No delegate CLI found — install claude or opencode.")); return; }
        const prompt =
          (req.skill ? composePrompt(req.skill, req.instruction) : req.instruction) +
          (req.priorOutputs ? `\n\nOutput of this routine's earlier steps:\n${req.priorOutputs}` : "");
        runDelegate(
          { cli, projectPath: req.projectPath ?? scratchDir(dir), prompt, model: req.model },
          { onOutput: () => {}, onDone: resolve, onError: reject },
          resolvedPathSpawnFn(resolvedPath),
          ROUTINE_STEP_TIMEOUT_MS,
        );
      });

    // Act-now note saving for routine chat steps (chat's propose_note stays confirm-first;
    // this is the pre-authorized routine counterpart — the user consented by writing the step).
    // Deliberately NOT added to actionTools: that array also backs the interactive chat window,
    // which must keep save_note confirm-first.
    const saveNoteTool: ActionTool = {
      spec: {
        name: "save_note",
        description: "Save a markdown note to the user's notes. Use only when the routine step's instruction asks for it.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "short note title" },
            body: { type: "string", description: "markdown body" },
          },
          required: ["title", "body"],
        },
      },
      run: async (args) => {
        const { title, body } = (args ?? {}) as { title?: unknown; body?: unknown };
        if (typeof title !== "string" || typeof body !== "string") return "error: save_note needs { title, body }";
        const slug = await saveNote(dbFile(dir), { title, body, source: "manual" });
        return `note saved as ${slug}`;
      },
    };

    const runOneRoutine = async (routine: Routine): Promise<RoutineRunResult> => {
      const skills = await loadLayeredSkills(skillsDir(projectDir), skillsDir(dir));
      return runRoutine(routine, {
        chat: runtime.converse,
        model: runtime.getModel(),
        delegate: delegateStep,
        tools: [...actionTools, saveNoteTool],
        findSkill: (name) => skills.find((s) => s.name === name),
      });
    };

    const deliverDigest = async (routine: Routine, result: RoutineRunResult): Promise<void> => {
      if (routine.sinks.note) {
        await saveNote(dbFile(dir), {
          title: `routine: ${routine.name}`,
          body: result.digest,
          source: "manual",
          slug: `routine-${routine.name}`, // update-in-place: one living note per routine
        });
      }
      for (const sink of routine.sinks.chatops ?? []) {
        await enqueueOutbox(outboxDir(dir), {
          transport: sink.transport, channel: sink.channel,
          title: `Routine: ${routine.name}`, body: result.digest,
        }, randomUUID);
      }
      if (routine.sinks.notify && notificationTransport.available()) {
        await notificationTransport.send({ title: `Routine: ${routine.name}`, body: result.digest });
      }
    };

    const routineScheduler = createRoutineScheduler({
      loadRoutines: () => loadRoutines(routinesPath),
      loadStates: () => loadRoutineStates(routineStatePath),
      saveStates: (s) => saveRoutineStates(routineStatePath, s),
      runRoutine: runOneRoutine,
      deliverDigest,
    });
    routineScheduler.start();
    app.on("before-quit", () => routineScheduler.stop());

    registerIpc(ipcMain, {
      loadSkills: loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona,
      loadMemories, saveMemories, appendMemories, extractMemories,
      loadNotes, saveNote, deleteNote,
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
      getConfig: () => ({
        openaiApiKey: runtime.getApiKey(),
        model: runtime.getModel(),
        terminalApp: runtime.getTerminalApp(),
        editorApp: runtime.getEditorApp(),
        delegateCli: runtime.getDelegateCli(),
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
      getAvailableClis: () => availableClis,
      beanDirPath: dir,
      modelMemoryFile: modelMemoryFile(dir),
      delegateTasks,
      delegateAvailable: () => availableClis.length > 0,
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
      installUpdate: (extractedAppPath: string) => installAndRelaunch(extractedAppPath),
      pendingUpdateStore,
      openReleasesPage: () => { void shell.openExternal("https://github.com/ScenK/Bean/releases"); },
      chatopsStatus: chatopsServers.status,
      chatopsStart: chatopsServers.start,
      chatopsStop: chatopsServers.stop,
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun, planFromDrop,
      getPendingPlan: planStore.get,
      getPendingDroppedUrl: droppedUrlStore.get,
      runInChat,
      getPendingChatPrompt: chatPromptStore.get,
      getPendingInterruptedRunNotices: interruptedRunStore.get,
      routineHandlers: buildRoutineHandlers({
        loadRoutines: () => loadRoutines(routinesPath),
        saveRoutine: (r) => saveRoutine(routinesPath, r),
        deleteRoutine: (name) => deleteRoutine(routinesPath, name),
        loadStates: () => loadRoutineStates(routineStatePath),
        isRunning: (name) => routineScheduler.isRunning(name),
        runNow: (name) => routineScheduler.runNow(name),
      }),
    });

    // Report any delegate run interrupted by the previous quit (delegate-tasks.ts's
    // interruptAll()/main.ts's own before-quit handler leave one outbox notice per run). A
    // one-shot claim, not a poll loop: main.ts is the only possible producer for the "chat"
    // transport, and only while it's dying — see .memory/project-durable-run-queue.md.
    const chatNotices = await claimOutbox(outboxDir(dir), "chat");
    if (chatNotices.length > 0) {
      const notices = chatNotices.map((m) => ({ text: m.body, display: m.displayBody ?? m.body }));
      interruptedRunStore.set(notices);
      openComponent("chat");
      const chat = componentWindows.get("chat");
      if (chat) sendToWindow(chat, IPC.interruptedRunNotice, notices);
    }
  } catch (err) {
    dialog.showErrorBox("Bean", err instanceof Error ? err.message : String(err));
  }
});

ipcMain.on(IPC.quit, () => app.quit());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
