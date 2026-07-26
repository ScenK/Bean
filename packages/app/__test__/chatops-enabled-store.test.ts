import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
