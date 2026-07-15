export interface Skill {
  /** Stable id derived from filename without extension, e.g. "review-code". */
  name: string;
  /** Short description the router reads to choose a skill. */
  description: string;
  /** Full markdown body used to compose the prompt. */
  body: string;
  /** `enabled: false` frontmatter hides the skill from the drag quick-launch. Absent = shown. */
  enabled?: boolean;
  /** `hidden: true` frontmatter fully hides the skill from every user-facing UI (Skills panel,
   * quick-launch, project default-skill picker, chat skill list) while keeping it in the
   * catalog `converse()` routes against. Filtered out only at the `listSkills` IPC boundary —
   * unlike `enabled`, there's no toggle for it. Absent = shown. */
  hidden?: boolean;
  /** Which layer's copy is currently in effect — set only by loadLayeredSkills(). Absent when
   * loaded via plain loadSkills() from a single dir. */
  source?: "project" | "user";
  /** True when this "user" skill has a same-named built-in counterpart it's shadowing — set
   * only by loadLayeredSkills(). Lets the UI offer "Reset" (delete the override, fall back to
   * the built-in) instead of a plain "Delete". */
  overridesBuiltIn?: boolean;
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
  /** Absent = "no project" — the run works in a scratch workspace instead of a picked
   * project (2a). Resolved to a bare scratch dir just before launch (scratchDir in
   * config.ts) — Bean never seeds it itself; see `sourceUrl` below. */
  projectPath?: string;
  /** Optional URL to prefill the "no project" picker's URL box with. Purely a UI seed —
   * ProposalCard folds it into the composed prompt text at confirm time (not resolved by
   * Bean into a clone/fetch) so the launched agent fetches/clones it itself if needed.
   * Distinct from RouteInput.droppedUrl, which seeds the prompt directly via composePrompt. */
  sourceUrl?: string;
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

