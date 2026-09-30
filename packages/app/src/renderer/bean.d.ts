import type {
  RouteInput, RouteSuggestion, ChatRequest, ConverseResult, Skill, Project, Persona, LaunchRequest, CliName,
  Memory, ChatTurn, DreamDigest, Note, NoteDraft, AvailableModel, Routine, TodoItem,
  RoutineBrief, RoutineWatch, WatchItem,
} from "@bean/core";
import type { Theme, ComponentKind, AvatarMode, ConfigView, ConfigUpdate, AppInfo, UpdateStatus, InstallUpdateResult } from "../channels.js";
import type { DelegateEvent, DelegateStartRequest } from "../delegate-tasks.js";
import type { TaskJob } from "../task-status.js";
import type { ChatopsBot, ChatopsEvent, ChatopsState } from "../chatops-servers.js";
import type { RoutineStateView, InterruptedRunNotice, SinkRecipients, BriefDraft, MemoryBatch } from "../ipc.js";
import type { RoutineBuildView } from "../routine-builder.js";
import type { WatchCheckResult } from "../routine-scheduler.js";

declare global {
  interface Window {
    bean: {
      route(input: RouteInput): Promise<RouteSuggestion>;
      launch(req: LaunchRequest): void;
      delegateStart(req: DelegateStartRequest): Promise<string>;
      delegateCancel(taskId: string): void;
      onDelegateEvent(cb: (e: DelegateEvent) => void): void;
      availableClis(): Promise<CliName[]>;
      detectedClis(): Promise<CliName[]>;
      availableModels(): Promise<AvailableModel[]>;
      onCliAvailabilityChanged(cb: () => void): void;
      getModelMemory(skillName: string): Promise<string | undefined>;
      setModelMemory(skillName: string, modelId: string): Promise<void>;
      chat(req: ChatRequest): Promise<ConverseResult>;
      onChatImageProgress(cb: () => void): void;
      getModel(): Promise<string>;
      getPathForFile(file: File): string;
      getTheme(): Promise<Theme>;
      setTheme(t: Theme): Promise<void>;
      onThemeChanged(cb: (t: Theme) => void): void;
      openComponent(kind: ComponentKind, droppedUrl?: string): Promise<void>;
      onComponentDroppedUrl(cb: (url: string) => void): void;
      getPendingDroppedUrl(): Promise<string | undefined>;
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
      planFromDrop(skillName: string, droppedUrl: string): void;
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
      listNotes(): Promise<Note[]>;
      saveNote(draft: NoteDraft): Promise<string>;
      deleteNote(slug: string): Promise<void>;
      starNote(slug: string, starred: boolean): Promise<void>;
      noteHistory(slug: string): Promise<Note[]>;
      routinesList(): Promise<Routine[]>;
      routinesSave(routine: Routine): Promise<void>;
      routinesDelete(name: string): Promise<void>;
      routinesState(): Promise<Record<string, RoutineStateView>>;
      routinesRunNow(name: string): Promise<{ started: boolean; reason?: string }>;
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
      /** Fire-and-forget at chat close: main extracts + saves in the background. */
      rememberOnClose(transcript: ChatTurn[], opts: { incognito: boolean }): void;
      getMemoryBatch(): Promise<MemoryBatch | undefined>;
      undoMemoryBatch(): Promise<number>;
      getLastDream(): Promise<DreamDigest | undefined>;
      /** Restores the last dream run; `skipped` groups were edited since and kept. */
      undoLastDream(): Promise<{ restored: number; skipped: number }>;
      dreamDetails(): Promise<{ before: string[]; after?: string }[]>;
      onReviewBeforeClose(cb: () => void): void;
      allowChatClose(): void;
      chatopsStatus(): Promise<Record<ChatopsBot, ChatopsState>>;
      chatopsStart(bot: ChatopsBot): void;
      chatopsStop(bot: ChatopsBot): void;
      onChatopsEvent(cb: (e: ChatopsEvent) => void): void;
    };
  }
}

export {};
