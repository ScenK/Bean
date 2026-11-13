import type {
  RouteSuggestion, ChatRequest, ConverseResult, Skill, Project, Persona, LaunchRequest, CliName,
  Memory, ChatTurn, DreamDigest, Note, NoteDraft, AvailableModel, Routine, TodoItem, ImageAttachment,
  RoutineBrief, RoutineWatch, WatchItem, ProposalOutcome,
} from "@bean/core";
import type { Theme, ComponentKind, DashboardTarget, ChatDrop, AvatarMode, ConfigView, ConfigUpdate, AppInfo, UpdateStatus, InstallUpdateResult, CoreListing, CoreStatus, CoreSwitchOutcome, CoreUpdateStatus, RemoteUpdateResult } from "../channels.js";
import type { Handshake, DelegateEvent, DelegateStartRequest, LiveEvent, LiveResumeResult, LiveStartRequest, LiveStartResult, TaskJob, ChatThreadSaveRequest, ChatThreadAck, PendingChatThread } from "@bean/host";
import type { TerminalEvent, TerminalStartResult } from "../terminal-tasks.js";
import type { ChatopsBot, ChatopsEvent, ChatopsState } from "@bean/host";
import type { InterruptedRunNotice } from "../ipc.js";
import type { SkillProposalView, StepAttemptView, RoutineStateView, SinkRecipients, BriefDraft, MemoryBatch, CloseTurn, RoutineBuildView, DestinationView, NameRawResult, SendResult } from "@bean/host";
import type { SyncedChatEvent, SyncedChatListing, SyncedChatRow, SyncedSendResult } from "../synced-chats.js";
import type { DeskContinueReply, DeskContinueRequest } from "../desk-continue.js";
import type { AliasResult } from "@bean/core";
import type { DesktopChatListing, RunStatus, WatchCheckResult } from "@bean/core";

declare global {
  interface Window {
    bean: {
      /** The host's contract version, core version, platform and capabilities (channel-contract.ts). */
      handshake(): Promise<Handshake>;
      launch(req: LaunchRequest): void;
      delegateStart(req: DelegateStartRequest, mountId: string): Promise<string>;
      delegateCancel(taskId: string): void;
      onDelegateEvent(cb: (e: DelegateEvent) => void): void;
      /** Start an agent session in this chat (mount); history is handed over as quoted context. */
      liveStart(req: LiveStartRequest, mountId: string): Promise<LiveStartResult>;
      /** Undefined = sent; otherwise why it wasn't (e.g. the next-turn queue is full). */
      liveSend(sessionId: string, text: string, mountId: string): Promise<string | undefined>;
      liveStop(sessionId: string, mountId: string): void;
      /** Stop the running turn, keep the session. `turns` = the `turn` events this chat has seen, so a
       * press that lands after that turn already ended is dropped. False = nothing was stopped. */
      liveInterrupt(sessionId: string, mountId: string, turns: number): Promise<boolean>;
      /** Continue live from a finished delegate card: only the receipt's session id goes over. */
      liveResume(sessionId: string, mountId: string): Promise<LiveResumeResult>;
      onLiveEvent(cb: (e: LiveEvent) => void): void;
      /** A login shell in one of this chat's tabs (tabId: a renderer-made UUID; at most 4 per chat):
       * "" = Bean's scratch workspace; a project no longer configured opens there too. */
      terminalStart(projectPath: string, cols: number, rows: number, mountId: string, tabId: string): Promise<TerminalStartResult>;
      terminalWrite(data: string, mountId: string, tabId: string): void;
      terminalResize(cols: number, rows: number, mountId: string, tabId: string): void;
      /** Output chars the tab has rendered — main pauses its shell past a watermark until acked. */
      terminalAck(chars: number, mountId: string, tabId: string): void;
      /** One tab, or every tab of the chat when none is named; resolves once the shells and their jobs are gone. */
      terminalStop(mountId: string, tabId?: string): Promise<void>;
      /** The commands in this chat's terminals' (or one tab's) foreground right now (main re-checks); idle shells left out. */
      terminalRunning(mountId: string, tabId?: string): Promise<string[]>;
      /** http(s) only; anything else is ignored. */
      terminalOpenLink(url: string, mountId: string): void;
      /** A Cmd+clicked path from the chat: main validates and resolves it, then opens a directory in
       * Finder, a file in the configured editor, or reveals it. Invalid or missing = ignored. */
      chatOpenPath(raw: string, mountId: string): void;
      onTerminalEvent(cb: (e: TerminalEvent) => void): void;
      availableClis(): Promise<CliName[]>;
      detectedClis(): Promise<CliName[]>;
      availableModels(): Promise<AvailableModel[]>;
      onCliAvailabilityChanged(cb: () => void): void;
      getModelMemory(skillName: string): Promise<string | undefined>;
      setModelMemory(skillName: string, modelId: string): Promise<void>;
      /** A chat session (mount id, a UUID) starts / ends in this window; every per-chat request names one. */
      chatAttach(mountId: string): void;
      chatRelease(mountId: string): void;
      chat(req: ChatRequest, mountId: string): Promise<ConverseResult>;
      /** Stop that chat's running Bean turn — ignored unless `turnId` is the one running; its `chat()` then resolves `stopped`. */
      chatStop(mountId: string, turnId: string): void;
      onChatImageProgress(cb: (mountId: string) => void): void;
      /** Writes a pasted/dragged image (base64) to a private temp file for an agent to read; its path. */
      chatStageImage(data: string, mime: string, mountId: string): Promise<string>;
      getModel(): Promise<string>;
      getPathForFile(file: File): string;
      getTheme(): Promise<Theme>;
      setTheme(t: Theme): Promise<void>;
      onThemeChanged(cb: (t: Theme) => void): void;
      openComponent(kind: ComponentKind, payload?: ChatDrop | DashboardTarget): Promise<void>;
      onComponentDroppedUrl(cb: (drop: ChatDrop) => void): void;
      getPendingDroppedUrl(): Promise<ChatDrop | undefined>;
      onDashboardTarget(cb: (t: DashboardTarget) => void): void;
      getPendingDashboardTarget(): Promise<DashboardTarget | undefined>;
      proposeRun(suggestion: RouteSuggestion): void;
      getPendingPlan(): Promise<RouteSuggestion | undefined>;
      onProposeRun(cb: (suggestion: RouteSuggestion) => void): void;
      moveWindowBy(dx: number, dy: number): void;
      resizeWindowToContent(height: number): void;
      setAvatarMode(mode: AvatarMode): void;
      onAvatarReset(cb: () => void): void;
      onAvatarFoldMenu(cb: () => void): void;
      onAvatarDragLayout(cb: (p: { x: number; y: number; tilesAbove?: boolean; bubblesBelow?: boolean; stackMax?: number }) => void): void;
      setAvatarStatusHeight(height: number): void;
      onTaskStatus(cb: (jobs: TaskJob[]) => void): void;
      dismissTask(id: string): void;
      /** Focus the chat window and show the chat (mount) that owns a bubble's task. */
      openChatMount(mountId: string): void;
      onShowChatMount(cb: (mountId: string) => void): void;
      /** The plan for a URL dropped on a skill tile (show it with proposeRun). */
      planDrop(skillName: string, droppedUrl: string): Promise<RouteSuggestion>;
      runInChat(prompt: string, label: string, noteSlug?: string): void;
      getPendingChatPrompt(): Promise<{ prompt: string; label: string; noteSlug?: string } | undefined>;
      onChatPrompt(cb: (p: { prompt: string; label: string; noteSlug?: string }) => void): void;
      getPendingInterruptedRunNotices(): Promise<InterruptedRunNotice[] | undefined>;
      onInterruptedRunNotice(cb: (notices: InterruptedRunNotice[]) => void): void;
      listSkills(): Promise<Skill[]>;
      listProjects(): Promise<Project[]>;
      saveProjects(projects: Project[]): Promise<void>;
      pickProjectFolder(): Promise<string | undefined>;
      pickTerminalApp(): Promise<string | undefined>;
      pickEditorApp(): Promise<string | undefined>;
      revealInFinder(path: string): void;
      saveSkill(name: string, body: string): Promise<void>;
      deleteSkill(name: string): Promise<void>;
      getPersona(): Promise<Persona>;
      savePersona(p: Persona): Promise<void>;
      getConfig(): Promise<ConfigView>;
      saveConfig(update: ConfigUpdate): Promise<void>;
      getAppInfo(): Promise<AppInfo>;
      quitApp(): void;
      checkForUpdate(): Promise<UpdateStatus>;
      installUpdate(): Promise<InstallUpdateResult | undefined>;
      openUpdateReleasePage(): void;
      /** Cores panel (#811): the saved cores and which one is selected. */
      coreList(): Promise<CoreListing>;
      /** Saves a remote core (`user@host`, optional Docker container); doesn't switch to it. */
      coreAdd(host: string, container?: string): Promise<{ id: string } | { error: string }>;
      coreRemove(id: string): Promise<void>;
      /** Switch to a core ("local" = this Mac): the chat window's Keep/Stop review, then Bean restarts. */
      coreSwitch(id: string): Promise<CoreSwitchOutcome>;
      /** The attachment's state: host badge, reconnect bar, takeover and version banners. */
      coreStatus(): Promise<CoreStatus>;
      onCoreStatus(cb: (s: CoreStatus) => void): void;
      /** After another machine took the core over: attach again. */
      coreTakeBack(): void;
      /** A remote core (#838): its version, a newer release if any, and what an update would stop. */
      coreUpdateStatus(): Promise<CoreUpdateStatus>;
      /** Update the remote core; `force` stops its busy work. "updated" = it's restarting. */
      coreUpdateApply(force: boolean): Promise<RemoteUpdateResult>;
      /** Live notes; `includeArchived` adds archived ones (each with `archivedAt`). */
      listNotes(opts?: { includeArchived?: boolean }): Promise<Note[]>;
      saveNote(draft: NoteDraft, images?: ImageAttachment[]): Promise<string>;
      saveNoteImage(bytes: Uint8Array): Promise<string>;
      noteImage(id: string): Promise<string | undefined>;
      archiveNote(slug: string): Promise<void>;
      restoreNote(slug: string): Promise<void>;
      /** Permanently deletes an archived note and its history. */
      purgeNote(slug: string): Promise<void>;
      starNote(slug: string, starred: boolean): Promise<void>;
      noteHistory(slug: string): Promise<Note[]>;
      skillProposalsList(): Promise<{ pending: SkillProposalView[]; applied: SkillProposalView[] }>;
      skillProposalsApprove(id: string): Promise<ProposalOutcome>;
      skillProposalsReject(id: string): Promise<ProposalOutcome>;
      skillProposalsUndo(id: string): Promise<ProposalOutcome>;
      routinesList(): Promise<Routine[]>;
      routinesSave(routine: Routine): Promise<void>;
      routinesDelete(name: string): Promise<void>;
      routinesState(): Promise<Record<string, RoutineStateView>>;
      routinesAttempts(runId: string): Promise<StepAttemptView[]>;
      routinesRunNow(name: string): Promise<{ started: boolean; reason?: string; status?: RunStatus; stopped?: true }>;
      routineStop(name: string): Promise<void>;
      routinesCheckNow(name: string): Promise<WatchCheckResult>;
      routinesPreviewWatch(watch: RoutineWatch): Promise<WatchItem[]>;
      routinesEnableWatch(name: string, queueExisting: boolean): Promise<{ count: number }>;
      routinesSinkRecipients(): Promise<SinkRecipients>;
      routinesDraftBrief(sentence: string, previous?: RoutineBrief): Promise<BriefDraft>;
      routinesBuild(brief: RoutineBrief): Promise<void>;
      routinesBuilds(): Promise<RoutineBuildView[]>;
      routinesCancelBuild(name: string): Promise<void>;
      routinesDismissBuild(name: string): Promise<void>;
      todosList(routine: string): Promise<TodoItem[]>;
      todosListAll(): Promise<TodoItem[]>;
      todosAdd(routine: string, text: string): Promise<TodoItem>;
      todosEdit(id: string, text: string): Promise<void>;
      todosDelete(id: string): Promise<void>;
      todosReorder(id: string, newOrder: number): Promise<void>;
      todosClearFinished(routine: string): Promise<void>;
      todosRetry(id: string): Promise<void>;
      listMemories(): Promise<Memory[]>;
      appendMemories(additions: Memory[]): Promise<void>;
      updateMemory(id: string, text: string): Promise<void>;
      deleteMemories(ids: string[]): Promise<number>;
      /** Per-row recategorize; null/empty uncategorizes. */
      updateMemoryCategory(id: string, category: string | null): Promise<void>;
      /** Renames a category on every row; returns rows changed. */
      renameMemoryCategory(from: string, to: string): Promise<number>;
      /** The owner's chatops ids, so Persona files owner-DM rows under the owner's sections. */
      memoryOwnerIds(): Promise<string[]>;
      /** Fire-and-forget at chat close: main extracts + saves in the background. */
      rememberOnClose(transcript: CloseTurn[], opts: { incognito: boolean; rejected: string[]; mountId: string }): void;
      setChatIncognito(on: boolean, mountId: string): void;
      /** Write-through of this chat's transcript; undefined = refused (the chat went incognito). */
      chatThreadSave(req: ChatThreadSaveRequest, mountId: string): Promise<ChatThreadAck | undefined>;
      /** A saved thread for this chat (mount) to restore; refused if another open chat holds it. */
      chatThreadGet(id: string, mountId: string): Promise<PendingChatThread>;
      /** Saved threads, newest first (main prunes past 90 days on each list). */
      chatThreadList(): Promise<DesktopChatListing[]>;
      /** Refused for a thread any open chat holds. */
      chatThreadDelete(id: string): Promise<void>;
      /** Sets a thread's star: its resulting `updatedAt`, or undefined when the thread is gone. */
      chatThreadStar(id: string, starred: boolean): Promise<string | undefined>;
      /** Renames a thread (later saves keep it): the stored title, or undefined when the thread is gone. Refused for an empty title. */
      chatThreadRename(id: string, title: string): Promise<string | undefined>;
      /** Puts 1–100 threads in a named group, starring them; `null` ungroups them and keeps the star. The ids updated (gone ones skipped). Refused for an empty name. */
      chatThreadGroup(ids: string[], name: string | null): Promise<string[]>;
      /** Renames a group (onto an existing name, they merge): the moved ids. */
      chatThreadGroupRename(from: string, to: string): Promise<string[]>;
      /** The owner's Discord/Teams conversations, newest first. */
      syncedChatList(): Promise<SyncedChatListing[]>;
      /** One listed conversation's transcript, mapped for display. */
      syncedChatGet(surface: string, conversationId: string, mountId: string): Promise<SyncedChatRow[]>;
      /** A desk turn into a listed conversation: the bot's ack, or why there was none. */
      syncedChatSend(surface: string, conversationId: string, text: string, mountId: string): Promise<SyncedSendResult>;
      /** Continue live: asks the bot to reopen the conversation's ended live session. */
      syncedChatResume(surface: string, conversationId: string, mountId: string): Promise<SyncedSendResult>;
      onSyncedChatEvent(cb: (e: SyncedChatEvent) => void): void;
      /** Continue in Discord: opens a thread under a Discord channel and carries this chat (or its
       * agent session) over. The bot's ack, or why there was none. */
      deskContinue(req: DeskContinueRequest, mountId: string): Promise<DeskContinueReply>;
      /** Tagged with the chat (mount) whose turn it captured. */
      onMemoryUpdated(cb: (saved: Array<{ id: string; text: string; category?: string }>, mountId: string) => void): void;
      getMemoryBatch(): Promise<MemoryBatch | undefined>;
      undoMemoryBatch(): Promise<number>;
      getLastDream(): Promise<DreamDigest | undefined>;
      /** Restores the last dream run; `skipped` groups were edited since and kept. */
      undoLastDream(): Promise<{ restored: number; skipped: number }>;
      dreamDetails(): Promise<{ before: string[]; after?: string }[]>;
      onReviewBeforeClose(cb: () => void): void;
      allowChatClose(): void;
      /** The Keep/Stop card's "Keep working": a switch or quit waiting on the close is called off. */
      chatCloseKept(): void;
      chatopsStatus(): Promise<Record<ChatopsBot, ChatopsState>>;
      /** Settings → ChatOps → Destinations: every conversation the bots have seen. */
      destinationsList(): Promise<DestinationView[]>;
      /** Name or rename a row; refused (ok: false) for a referenced alias or a taken name. */
      destinationsName(surface: string, conversationId: string, alias: string): Promise<AliasResult>;
      destinationsClear(surface: string, conversationId: string): Promise<AliasResult>;
      /** Move `alias` to another row of the same platform. */
      destinationsRetarget(alias: string, surface: string, conversationId: string): Promise<AliasResult>;
      /** "Name it" on a raw-id sink: name that conversation, rewrite the id to the alias in every sprout using it. */
      destinationsNameRaw(surface: string, conversationId: string, alias: string): Promise<NameRawResult>;
      /** Confirms a propose_send card: queues its frozen body to the picked option. */
      sendToDestination(proposalId: string, optionId: string): Promise<SendResult>;
      chatopsStart(bot: ChatopsBot): void;
      chatopsStop(bot: ChatopsBot): void;
      onChatopsEvent(cb: (e: ChatopsEvent) => void): void;
    };
  }
}

export {};
