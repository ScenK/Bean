import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskJob } from "./task-status.js";

// Keeps the Mac from idle-sleeping (#188): held while Bean runs delegate/routine work, or always
// when the tray's Keep Mac Awake is checked. One blocker id at most — every streamed delegate
// line re-sends the job list, so a naive start() per update would leak assertions. The display
// may still sleep; the assertion dies with the process, so there's no quit hook.
export function createKeepAwake(deps: {
  start: () => number;
  stop: (id: number) => void;
  onChange?: (held: boolean) => void;
}) {
  let alwaysOn = false;
  let working = false;
  let id: number | undefined;
  const reconcile = (): void => {
    const want = alwaysOn || working;
    if (want === (id !== undefined)) return;
    // A power failure must never break the task-status update that triggered it.
    try {
      if (want) id = deps.start();
      else { const cur = id!; id = undefined; deps.stop(cur); }
    } catch { /* keep the old state; next change retries */ }
    deps.onChange?.(id !== undefined);
  };
  return {
    setAlwaysOn(on: boolean): void { alwaysOn = on; reconcile(); },
    setJobs(jobs: TaskJob[]): void {
      working = jobs.some((j) => (j.kind === "delegate" || j.kind === "routine") && j.state === "running");
      reconcile();
    },
    alwaysOn: (): boolean => alwaysOn,
    held: (): boolean => id !== undefined,
  };
}

export function keepAwakeFile(userDataDir: string): string {
  return join(userDataDir, "keep-awake.json");
}

/** Missing or invalid file = off. */
export async function loadKeepAwake(file: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { alwaysOn?: unknown }).alwaysOn === true;
  } catch {
    return false;
  }
}

/** Write-then-rename, like chatops-enabled-store.ts; callers chain writes so the fixed temp name is safe. */
export async function saveKeepAwake(file: string, alwaysOn: boolean): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ alwaysOn }), "utf8");
  await rename(tmp, file);
}
