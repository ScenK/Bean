import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatopsEnabledFile, loadChatopsEnabled, saveChatopsEnabled } from "../src/chatops-enabled-store.js";

async function tmpFile(): Promise<string> {
  return chatopsEnabledFile(await mkdtemp(join(tmpdir(), "bean-chatops-")));
}

describe("chatops enabled store", () => {
  it("round-trips the enabled bots", async () => {
    const file = await tmpFile();
    await saveChatopsEnabled(file, ["teams"]);
    expect(await loadChatopsEnabled(file)).toEqual(["teams"]);
  });

  // writeFile truncates first, so a crash mid-write would otherwise leave a partial file that
  // loads as "nothing enabled" — silently switching every bot off.
  it("replaces the file atomically and leaves no temp file behind", async () => {
    const file = await tmpFile();
    await saveChatopsEnabled(file, ["discord"]);
    await saveChatopsEnabled(file, ["discord", "teams"]);
    expect(await readdir(dirname(file))).toEqual(["chatops-enabled.json"]);
    expect(await loadChatopsEnabled(file)).toEqual(["discord", "teams"]);
  });

  it("returns nothing when the file is missing or garbage", async () => {
    expect(await loadChatopsEnabled(join(tmpdir(), "bean-chatops-nope", "x.json"))).toEqual([]);
    const file = await tmpFile();
    await saveChatopsEnabled(file, []);
    await writeFile(file, "{not json", "utf8");
    expect(await loadChatopsEnabled(file)).toEqual([]);
  });

  it("drops unknown bot names instead of feeding them to start()", async () => {
    const file = await tmpFile();
    await saveChatopsEnabled(file, []);
    await writeFile(file, JSON.stringify({ enabled: ["discord", "slack", 7] }), "utf8");
    expect(await loadChatopsEnabled(file)).toEqual(["discord"]);
  });
});
