export interface Skill {
  /** Stable id derived from filename without extension, e.g. "review-code". */
  name: string;
  /** Short description the router reads to choose a skill. */
  description: string;
  /** Full markdown body used to compose the prompt. */
  body: string;
  /** `enabled: false` frontmatter hides the skill from the drag quick-launch. Absent = shown. */
  enabled?: boolean;
  /** Which layer's copy is currently in effect — set only by loadLayeredSkills(). Absent when
   * loaded via plain loadSkills() from a single dir. */
  source?: "project" | "user";
  /** `target: chat` frontmatter runs the skill in Bean's own chat instead of the terminal.
   * Absent = terminal. */
  target?: "chat" | "terminal";
}

export interface Project {
  name: string;
  path: string;
  defaultSkill?: string;
  /** Names of skills grouped under this project in the Skills panel. Many-to-many: a skill
   * name can appear in multiple projects' lists. Separate from `defaultSkill`, which is an
   * unrelated best-guess fallback used by the router/drop-plan/avatar heuristics. */
  skills?: string[];
}

export interface RouteInput {
  userText: string;
  droppedUrl?: string;
}

export interface RouteSuggestion {
  skillName: string;
  projectPath: string;
  composedPrompt: string;
  confidence: number; // 0..1
  /** Where a confirmed run executes: "chat" submits the prompt into Bean's chat;
   * absent/"terminal" launches externally as before. Copied from the skill's `target`. */
  target?: "chat" | "terminal";
}

export interface BeanConfig {
  openaiApiKey: string;
  model: string;
  terminalApp: string; // "" = use the system default handler for .command files
  editorApp: string; // "" = no editor configured — "Open in Editor" prompts the user to set one
  delegateCli: string; // "" = auto: first detected CLI; else "claude"/"opencode"
  beanDir: string; // resolved absolute path to ~/.bean
}

