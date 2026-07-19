import type {
  RouteInput, RouteSuggestion, ChatRequest, ConverseResult, Skill, Project, Persona, LaunchRequest, CliName,
  Memory, MemoryCandidate, ChatTurn, Note, NoteDraft, AvailableModel, Routine, TodoItem,
} from "@bean/core";
import type { Theme, ComponentKind, AvatarMode, ConfigView, ConfigUpdate, AppInfo, UpdateStatus, InstallUpdateResult } from "../channels.js";
import type { DelegateEvent, DelegateStartRequest } from "../delegate-tasks.js";
import type { ChatopsBot, ChatopsEvent, ChatopsState } from "../chatops-servers.js";
import type { RoutineStateView, InterruptedRunNotice } from "../ipc.js";

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
      getModelMemory(skillName: string): Promise<string | undefined>;
      setModelMemory(skillName: string, modelId: string): Promise<void>;
      chat(req: ChatRequest): Promise<ConverseResult>;
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
      onAvatarFoldMenu(cb: () => void): void;
      onAvatarDragLayout(cb: (p: { x: number; y: number }) => void): void;
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
      noteHistory(slug: string): Promise<Note[]>;
      routinesList(): Promise<Routine[]>;
      routinesSave(routine: Routine): Promise<void>;
      routinesDelete(name: string): Promise<void>;
      routinesState(): Promise<Record<string, RoutineStateView>>;
      routinesRunNow(name: string): Promise<{ started: boolean; reason?: string }>;
      todosList(routine: string): Promise<TodoItem[]>;
      todosListAll(): Promise<TodoItem[]>;
      todosAdd(routine: string, text: string): Promise<TodoItem>;
      todosEdit(id: string, text: string): Promise<void>;
      todosDelete(id: string): Promise<void>;
      todosReorder(id: string, newOrder: number): Promise<void>;
      todosClearFinished(routine: string): Promise<void>;
      todosRetry(id: string): Promise<void>;
      listMemories(): Promise<Memory[]>;
      saveMemories(memories: Memory[]): Promise<void>;
      appendMemories(additions: Memory[]): Promise<void>;
      extractMemories(transcript: ChatTurn[]): Promise<MemoryCandidate[]>;
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
