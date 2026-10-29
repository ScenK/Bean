import type {
  RouteInput, RouteSuggestion, ChatRequest, ConverseResult, Skill, Project, Persona, LaunchRequest, CliName,
  Memory, ChatTurn, DreamDigest, Note, NoteDraft, AvailableModel, Routine, TodoItem, ImageAttachment,
  RoutineBrief, RoutineWatch, WatchItem, ProposalOutcome,
} from "@bean/core";
import type { Theme, ComponentKind, DashboardTarget, AvatarMode, ConfigView, ConfigUpdate, AppInfo, UpdateStatus, InstallUpdateResult } from "../channels.js";
import type { DelegateEvent, DelegateStartRequest } from "../delegate-tasks.js";
import type { TaskJob } from "../task-status.js";
import type { ChatopsBot, ChatopsEvent, ChatopsState } from "../chatops-servers.js";
import type { SkillProposalView, StepAttemptView, RoutineStateView, InterruptedRunNotice, SinkRecipients, BriefDraft, MemoryBatch, CloseTurn } from "../ipc.js";
import type { RoutineBuildView } from "../routine-builder.js";
import type { WatchCheckResult } from "@bean/core";

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
      openComponent(kind: ComponentKind, payload?: string | DashboardTarget): Promise<void>;
      onComponentDroppedUrl(cb: (url: string) => void): void;
      getPendingDroppedUrl(): Promise<string | undefined>;
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
      rememberOnClose(transcript: CloseTurn[], opts: { incognito: boolean; rejected: string[] }): void;
      setChatIncognito(on: boolean): void;
      onMemoryUpdated(cb: (saved: Array<{ id: string; text: string }>) => void): void;
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
