import type { SeenDestination } from "@bean/core";
import type { ConversationReference } from "botbuilder";
import { expect, test, vi } from "vitest";
import { teamsDestination, teamsDestinationRecorder } from "../src/destinations.js";

type Conv = ConversationReference["conversation"];
const ref = (conversation: Partial<Conv>, extra: Partial<ConversationReference> = {}): Partial<ConversationReference> =>
  ({ conversation: conversation as Conv, ...extra });
const noTitle = async (): Promise<undefined> => undefined;

test("a channel post is recorded under its bare channel id with channelData's names", () => {
  const post = ref({ id: "19:abc@thread.tacv2;messageid=1700", conversationType: "channel" });
  expect(teamsDestination(post, { channel: { id: "19:abc@thread.tacv2", name: "Ops" }, team: { id: "19:team", name: "Platform" } }))
    .toEqual({ surface: "teams", conversationId: "19:abc@thread.tacv2", kind: "channel", platformName: "Ops", parentName: "Platform" });
  // The General channel arrives unnamed; its id is the team's.
  expect(teamsDestination(post, { channel: { id: "19:t" }, team: { id: "19:t", name: "Platform" } })?.platformName).toBe("General");
  // A stored ref (outbox delivery) has no channelData: no names, so the known ones are kept.
  expect(teamsDestination(post)).toMatchObject({ conversationId: "19:abc@thread.tacv2", platformName: undefined });
});

test("group chats, meetings and real DMs; a targeted personal ref is skipped", () => {
  expect(teamsDestination(ref({ id: "19:g@thread.v2", conversationType: "groupChat", name: "Lunch" })))
    .toMatchObject({ kind: "group", platformName: "Lunch" });
  expect(teamsDestination(ref({ id: "19:meeting_x@thread.v2", conversationType: "groupChat" })))
    .toMatchObject({ kind: "meeting" });
  expect(teamsDestination(ref({ id: "a:dm", conversationType: "personal" }, { user: { id: "29:u", name: "Ana" } })))
    .toEqual({ surface: "teams", conversationId: "a:dm", kind: "dm", platformName: "Ana" });
  const picked = ref({ id: "a:pick", conversationType: "personal" }, { bot: { id: "28:bean", name: "Bean", isTargeted: true } as ConversationReference["bot"] });
  expect(teamsDestination(picked)).toBeUndefined();
});

test("a meeting's title is fetched once per meeting id", async () => {
  const seen: SeenDestination[] = [];
  const rec = teamsDestinationRecorder((s) => seen.push(s));
  const meeting = ref({ id: "19:meeting_x@thread.v2", conversationType: "groupChat" });
  const title = vi.fn(async () => "Standup");
  await rec.seen(meeting, { meeting: { id: "m1" } }, title);
  await rec.seen(meeting, { meeting: { id: "m1" } }, title);
  expect(title).toHaveBeenCalledTimes(1);
  expect(seen.map((s) => s.platformName)).toEqual([undefined, "Standup", undefined]);
});

test("a throwing recorder or meeting lookup never fails the turn or the delivery", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rec = teamsDestinationRecorder(() => { throw new Error("db locked"); });
  const meeting = ref({ id: "19:meeting_y@thread.v2", conversationType: "groupChat" });
  await expect(rec.seen(meeting, { meeting: { id: "m2" } }, async () => { throw new Error("403"); })).resolves.toBeUndefined();
  expect(() => rec.delivered(ref({ id: "19:abc@thread.tacv2", conversationType: "channel" }))).not.toThrow();
  await expect(rec.seen(ref({ id: "a:dm", conversationType: "personal" }), undefined, noTitle)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(4);
  warn.mockRestore();
});
