import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { app, ipcMain, dialog, BrowserWindow, nativeTheme, Notification, Tray, Menu, nativeImage } from "electron";
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile, projectBeanDir, memoryFile, remindersFile,
  loadConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona, saveConfig,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill, loadMemories, saveMemories, extractMemories,
  loadReminders, saveReminders, dueReminders, extractPageText,
  loadNotes, saveNote, deleteNote, notesDir, detectClis, loginShellPath,
} from "@bean/core";
import type { RouteSuggestion, ActionTool } from "@bean/core";
import { createAvatarWindow, createComponentWindow } from "./windows.js";
import { registerIpc, buildPlanStore, buildDroppedUrlStore, buildChatPromptStore, type ChatPromptPayload } from "./ipc.js";
import { IPC, type Theme, type ComponentKind } from "./channels.js";
import { saveTheme, themeFile } from "./theme-store.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { sendToWindow, trackComponentWindow } from "./component-window-registry.js";

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
  // Menu-bar app: no Dock icon; the tray is the persistent presence.
  app.dock?.hide();

  const avatar = createAvatarWindow();
  avatar.on("closed", () => { /* keep app */ });

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
  tray = new Tray(trayIcon);
  if (trayIcon.isEmpty()) tray.setTitle("🫘");
  tray.setToolTip("Bean");
  // Settings/Persona/About/Exit — the avatar's left-click quick actions (Chat/Skills/Projects/
  // Notes, see QUICK_ACTIONS in renderer/avatar.ts) cover the rest. No right-click on the tray.
  // Icons are SF Symbols via createMenuSymbol (macOS-native, no asset files needed); accelerators
  // follow macOS convention (⌘, for preferences, ⌘Q for quit) — About has none, matching the
  // system App menu, where About never gets a shortcut either.
  const symbol = (name: string) => nativeImage.createMenuSymbol(name);
  const trayMenu = Menu.buildFromTemplate([
    { label: "Settings", icon: symbol("gearshape"), accelerator: "Cmd+,", click: () => openComponent("settings") },
    { label: "Persona", icon: symbol("person.crop.circle"), accelerator: "Cmd+P", click: () => openComponent("persona") },
    { label: "About", icon: symbol("info.circle"), click: () => openComponent("about") },
    { label: "Exit", icon: symbol("rectangle.portrait.and.arrow.right"), accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
  tray.on("click", () => tray?.popUpContextMenu(trayMenu));

  let quitting = false;
  app.on("before-quit", () => { quitting = true; });
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
    const win = createComponentWindow(kind, avatar.getBounds());
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

  setInterval(() => {
    void (async () => {
      const reminders = await loadReminders(remindersPath);
      const due = dueReminders(reminders, new Date());
      if (due.length === 0) return;
      const firedAt = new Date().toISOString();
      for (const r of due) {
        const n = new Notification({ title: "Bean", body: r.text });
        n.on("click", () => openComponent("chat"));
        n.show();
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

    registerIpc(ipcMain, {
      loadSkills: loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona,
      loadMemories, saveMemories, extractMemories,
      loadNotes, saveNote, deleteNote,
      notesDir: notesDir(dir),
      chat: runtime.chat,
      converse: runtime.converse,
      getModel: runtime.getModel,
      projectSkillsDir: skillsDir(projectDir),
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      personaFile: personaFile(dir),
      projectPersonaFile: personaFile(projectDir),
      memoryFile: memoryFile(dir),
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
      // PATH doesn't change mid-session — detect once, serve from cache. Finder-launched
      // Electron gets a minimal PATH missing whatever the user's shell profile adds (nvm,
      // npm/pnpm global bins, ~/.local/bin, ...) — ask the login shell for its real PATH.
      getAvailableClis: (() => {
        const clis = detectClis(
          [process.env.PATH ?? "", loginShellPath(), "/opt/homebrew/bin", "/usr/local/bin"].join(":"),
        );
        return () => clis;
      })(),
      onLaunchError: (req, err) => {
        const label = req.mode === "open" ? "open the project in your editor" : `launch (${req.mode})`;
        dialog.showErrorBox("Bean", `Couldn't ${label}: ${err.message}`);
      },
      getAppInfo: () => ({
        version: pkg.version,
        author: pkg.author,
        description: pkg.description,
      }),
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun, planFromDrop,
      getPendingPlan: planStore.get,
      getPendingDroppedUrl: droppedUrlStore.get,
      runInChat,
      getPendingChatPrompt: chatPromptStore.get,
    });
  } catch (err) {
    dialog.showErrorBox("Bean", err instanceof Error ? err.message : String(err));
  }
});

ipcMain.on(IPC.quit, () => app.quit());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
