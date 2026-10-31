import type { ConversationReference, TurnContext } from "botbuilder";
import { expect, test } from "vitest";
import { isDirect, placeOf, proactiveEffects, refFor, refScope, type ContinueConversation } from "../src/proactive.js";

const CHANNEL = "19:abc@thread.tacv2";
const POST = `${CHANNEL};messageid=1700`;
const DM = "a:personal-1";
const refs: Record<string, Partial<ConversationReference>> = {
  [DM]: { serviceUrl: "https://smba", conversation: { id: DM, conversationType: "personal" } as ConversationReference["conversation"] },
  [CHANNEL]: { serviceUrl: "https://smba", conversation: { id: CHANNEL, conversationType: "channel" } as ConversationReference["conversation"] },
};

/** Records which conversation each proactive activity went to. */
function recorder(): { calls: { conversationId?: string; activity: Record<string, unknown> }[]; cont: ContinueConversation } {
  const calls: { conversationId?: string; activity: Record<string, unknown> }[] = [];
  const cont: ContinueConversation = async (ref, fn) => {
    const record = async (activity: Record<string, unknown>) => {
      calls.push({ conversationId: ref.conversation?.id, activity });
      return { id: `act-${calls.length}` };
    };
    await fn({ sendActivity: record, updateActivity: record } as unknown as TurnContext);
  };
  return { calls, cont };
}

test("refFor targets the exact personal conversation", () => {
  expect(refFor(refs, DM)?.conversation?.id).toBe(DM);
  expect(refScope(refFor(refs, DM)!)).toBeUndefined();
});

test("refFor resolves a channel post via its bare channel ref but targets the full post id", () => {
  const ref = refFor(refs, POST);
  expect(ref?.conversation?.id).toBe(POST);
  expect(ref?.serviceUrl).toBe("https://smba");
  expect(refScope(ref!)).toBe(CHANNEL);
  // The stored ref is not mutated: a later digest still posts to the bare channel.
  expect(refs[CHANNEL]?.conversation?.id).toBe(CHANNEL);
});

test("refFor refuses a conversation Bean never saw", () => {
  expect(refFor(refs, "a:stranger")).toBeUndefined();
  expect(refFor(refs, "19:other@thread.tacv2;messageid=1")).toBeUndefined();
});

test("every proactive effect lands in the exact channel post", async () => {
  const { calls, cont } = recorder();
  const fx = proactiveEffects(refFor(refs, POST)!, cont);
  await fx.post("echo");
  await fx.reply("answer");
  expect(await fx.postCard({ type: "AdaptiveCard" })).toBe("act-3");
  await fx.updateCard("act-3", { type: "AdaptiveCard", v: 2 });
  expect(await fx.postStream!("streaming")).toBe("act-5");
  await fx.editStream!("act-5", "streamed");
  fx.sendTyping!();
  await Promise.resolve();
  expect(calls.map((c) => c.conversationId)).toEqual(Array(7).fill(POST));
  expect(calls[0]?.activity).toMatchObject({ type: "message", text: "echo" });
  expect(calls[3]?.activity).toMatchObject({ id: "act-3", conversation: { id: POST } });
  expect(calls[5]?.activity).toMatchObject({ id: "act-5", text: "streamed", conversation: { id: POST } });
  expect(calls[6]?.activity).toMatchObject({ type: "typing" });
});

test("proactive effects for a DM post to that DM", async () => {
  const { calls, cont } = recorder();
  await proactiveEffects(refFor(refs, DM)!, cont).post("hi");
  expect(calls).toEqual([{ conversationId: DM, activity: { type: "message", text: "hi" } }]);
});

test("a real 1:1 DM is direct; a targeted personal conversation (a / pick in a shared chat) is not", () => {
  const conversation = { id: DM, conversationType: "personal" } as ConversationReference["conversation"];
  const dm = { conversation, bot: { id: "28:bean", name: "Bean" } };
  expect(isDirect(dm)).toBe(true);
  expect(placeOf(dm)).toEqual({ kind: "dm", title: "DM" });
  const picked = { conversation, bot: { id: "28:bean", name: "Bean", isTargeted: true } as ConversationReference["bot"] };
  expect(isDirect(picked)).toBe(false);
  expect(placeOf(picked)).toEqual({ kind: "channel", title: "Teams chat" });
  expect(refScope(picked)).toBeUndefined(); // the a: id isn't the shared chat's: unscoped
  // Only a strict true targets: a stray truthy value never demotes a real DM.
  expect(isDirect({ conversation, bot: { id: "28:bean", name: "Bean", isTargeted: "true" } as unknown as ConversationReference["bot"] })).toBe(true);
});
