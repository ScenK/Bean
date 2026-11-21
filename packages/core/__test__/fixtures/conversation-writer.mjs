// A second process writing to one bean.db through the real ConversationStore source (Node strips
// the types; the hook maps the source's `.js` imports to their `.ts` files).
//   append <dbFile> <conversationId> <count> <tag>  — appends count turns, one turn_key each
//   compact <dbFile> <conversationId> <n>            — snapshots the oldest n, prints "ready", waits
//                                                      for a stdin line, then replaceOldest; prints the result
import { registerHooks } from "node:module";
import { createInterface } from "node:readline";

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (err) {
      if (spec.startsWith(".") && spec.endsWith(".js")) return next(`${spec.slice(0, -3)}.ts`, ctx);
      throw err;
    }
  },
});
const { ConversationStore } = await import("../../src/chatops/conversation.ts");

const [mode, file, id, n, tag] = process.argv.slice(2);
const store = new ConversationStore(file);
if (mode === "append") {
  for (let i = 0; i < Number(n); i++) store.append(id, { role: "user", content: `${tag}-${i}` }, { turnKey: `${tag}-${i}` });
} else {
  const snapshot = store.oldest(id, Number(n));
  console.log("ready");
  const rl = createInterface({ input: process.stdin });
  for await (const _ of rl) break;
  rl.close();
  console.log(String(store.replaceOldest(id, snapshot, { role: "user", content: `summary-${process.pid}` })));
}
