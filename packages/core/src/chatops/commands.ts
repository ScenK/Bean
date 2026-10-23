/** What a command's single argument is: an @mentioned user, a sprout name, or free text. */
export type ChatopsCommandOption = "user" | "name" | "prompt";

export interface ChatopsCommand {
  name: string;
  description: string;
  option?: ChatopsCommandOption;
}

/** Every keyword command `onCommand` answers — the one list a surface's command menu is built
 * from. Teams' manifest `commandLists` must name the same set (a test checks). */
export const CHATOPS_COMMANDS: readonly ChatopsCommand[] = [
  { name: "stop", description: "end the live session" },
  { name: "cancel", description: "cancel running delegated tasks" },
  { name: "new", description: "start a fresh conversation" },
  { name: "whoami", description: "show your Bean role" },
  { name: "live-session", description: "start an interactive coding session (owner only)", option: "prompt" },
  { name: "drivers", description: "who may steer the live session" },
  { name: "admins", description: "list this chat's admins" },
  { name: "add-admin", description: "owner only", option: "user" },
  { name: "remove-admin", description: "owner only", option: "user" },
  { name: "sprouts", description: "list sprouts (owner only)" },
  { name: "enable", description: "turn a sprout on (owner only)", option: "name" },
  { name: "disable", description: "turn a sprout off (owner only)", option: "name" },
];
