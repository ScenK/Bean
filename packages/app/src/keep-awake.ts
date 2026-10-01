import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskJob } from "./task-status.js";

type Blocker = "prevent-app-suspension" | "prevent-display-sleep";
export type KeepAwakeHeld = { system: boolean; display: boolean };
export type KeepAwakeState = { alwaysOn: boolean; display: boolean };

// Keeps the Mac from idle-sleeping (#188): the system blocker is held while Bean runs
// delegate/routine work, or always when the tray's Keep Mac Awake is checked. The display blocker
// (#202) is held only while Keep Mac Awake *and* Keep Display On are both checked — work never
// holds the display. At most one id per type — every streamed delegate line re-sends the job list,
// so a naive start() per update would leak assertions. The assertions die with the process, so
// there's no quit hook.
export function createKeepAwake(deps: {
  start: (type: Blocker) => number;
  stop: (id: number) => void;
  onChange?: (held: KeepAwakeHeld) => void;
}) {
  let alwaysOn = false;
  let display = false;
  let working = false;
  let systemId: number | undefined;
  let displayId: number | undefined;
  // Returns the new id; any failure keeps the old one (next change retries), and is caught per
  // type so a display failure never releases the system hold.
  const sync = (want: boolean, id: number | undefined, type: Blocker): number | undefined => {
    // A power failure must never break the task-status update that triggered it.
    try {
      if (want) return deps.start(type);
      deps.stop(id!);
      return undefined;
    } catch {
      return id;
    }
  };
  const reconcile = (): void => {
    const wantSystem = alwaysOn || working;
    const wantDisplay = alwaysOn && display;
    const systemDiff = wantSystem !== (systemId !== undefined);
    const displayDiff = wantDisplay !== (displayId !== undefined);
    if (!systemDiff && !displayDiff) return;
    if (systemDiff) systemId = sync(wantSystem, systemId, "prevent-app-suspension");
    if (displayDiff) displayId = sync(wantDisplay, displayId, "prevent-display-sleep");
    deps.onChange?.(held());
  };
  const held = (): KeepAwakeHeld => ({ system: systemId !== undefined, display: displayId !== undefined });
  return {
    setAlwaysOn(on: boolean): void { alwaysOn = on; reconcile(); },
    /** Stored even while always-on is off (remembered, greyed in the tray); holds only with it. */
    setDisplay(on: boolean): void { display = on; reconcile(); },
    setJobs(jobs: TaskJob[]): void {
      working = jobs.some((j) => (j.kind === "delegate" || j.kind === "routine") && j.state === "running");
      reconcile();
    },
    alwaysOn: (): boolean => alwaysOn,
    display: (): boolean => display,
    held,
  };
}

/** Tray tooltip, derived from the ids actually held rather than the flags. */
export function keepAwakeTooltip(held: KeepAwakeHeld): string {
  if (held.display) return "Bean — keeping Mac and display awake";
  return held.system ? "Bean — keeping Mac awake" : "Bean";
}

export function keepAwakeFile(userDataDir: string): string {
  return join(userDataDir, "keep-awake.json");
}

/** Missing or invalid file/field = off; a legacy `{ alwaysOn }` file loads with display off. */
export async function loadKeepAwake(file: string): Promise<KeepAwakeState> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { alwaysOn?: unknown; display?: unknown } | null;
    return { alwaysOn: raw?.alwaysOn === true, display: raw?.display === true };
  } catch {
    return { alwaysOn: false, display: false };
  }
}

/** Write-then-rename, like chatops-enabled-store.ts; callers chain writes so the fixed temp name is safe. */
export async function saveKeepAwake(file: string, state: KeepAwakeState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ alwaysOn: state.alwaysOn, display: state.display }), "utf8");
  await rename(tmp, file);
}
