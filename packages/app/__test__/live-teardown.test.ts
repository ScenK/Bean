import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// app.relaunch() + app.exit() skip before-quit, so the update relaunch must SIGKILL live trees
// itself: it goes through stopCore (#811), which force-kills them. The host's own quit hook is
// guarded in packages/host/__test__/live-tasks.test.ts.
test("the update relaunch force-kills live sessions", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  const relaunch = main.slice(main.indexOf("relaunch: () => {"), main.indexOf("});", main.indexOf("relaunch: () => {")));
  expect(relaunch).toContain("stopCore();");
  expect(main.slice(main.indexOf("stopCore = () => {")).split("};")[0]).toContain("h.liveTasks.forceKillAll();");
});
