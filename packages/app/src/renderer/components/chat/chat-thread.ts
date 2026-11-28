import type { LiveCli } from "@bean/core";
import { sproutFailureAsk } from "@bean/core/prompt";
import { newId, type ChatItem } from "../../shared/chat-types.js";

// A desktop chat thread's saved form — pure and node-free, so it tests without a DOM. Every save and
// every restore passes through normalizeForSave: nothing transient (task ids, live session ids,
// streaming flags, image bytes) reaches bean.db, and nothing restored can act — pending cards come
// back "expired", running work "interrupted", memory and forget receipts without Undo. See
// .memory/project-desktop-chat-history.md.

export const THREAD_TEXT_MAX = 20_000;
// core main-cutover.ts keeps a copy (node-free bundle rule) — keep in step.
export const SPROUT_UNKNOWN = "Started — see the Dashboard for how it went";
export const THREAD_ITEMS_MAX = 500;
// Renderer copy of core's DESKTOP_CHAT_MAX_BYTES (node-free bundle rule) — keep in step.
export const THREAD_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_PLACEHOLDER = "[image attached]";
export const pdfPlaceholder = (name: string): string => `[PDF attached: ${name}]`;
const PDF_PLACEHOLDER_RE = /\[PDF attached: ([^\]\n]+)\]$/;
const TITLE_MAX = 60;

const cap = (s: string): string => (s.length > THREAD_TEXT_MAX ? `${s.slice(0, THREAD_TEXT_MAX)}…` : s);
// A live agent's display is its progress prose ending in the final answer: keep the end.
const capEnd = (s: string): string => (s.length > THREAD_TEXT_MAX ? `…${s.slice(-THREAD_TEXT_MAX)}` : s);
const withPlaceholder = (text: string, had: boolean): string => (had ? `${text}\n${IMAGE_PLACEHOLDER}` : text);
// An instant, not a wall time: ISO with an explicit zone, so it means the same moment in any zone.
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** A saved `at` that is an ISO instant, or nothing — a bad one never reaches the divider rule. */
const validAt = (at: unknown): { at?: string } =>
  (typeof at === "string" && ISO_AT.test(at) && !Number.isNaN(Date.parse(at)) ? { at } : {});

function normalizeItem(it: ChatItem): ChatItem | undefined {
  switch (it.kind) {
    case "working":
      return undefined;
    case "user": {
      const { images, pdf, pending: _p, at, marker, ...rest } = it;
      const text = withPlaceholder(it.text, !!images?.length);
      return {
        ...rest, ...validAt(at), text: cap(pdf ? `${text}\n${pdfPlaceholder(pdf.name)}` : text),
        ...(it.display !== undefined ? { display: cap(it.display) } : {}),
        ...(typeof marker === "string" && marker.length <= 100 ? { marker } : {}),
      };
    }
    case "reply": {
      const { images, session: _s, tail: _t, stepCount: _sc, streaming, at, ...rest } = it;
      return {
        ...rest, ...validAt(at),
        text: cap(withPlaceholder(it.text, !!images?.length)),
        ...(it.display !== undefined ? { display: capEnd(it.display) } : {}),
        ...(streaming ? { footer: "— turn interrupted" } : {}),
      };
    }
    case "delegate": {
      const { taskId: _t, ...rest } = it;
      const state = it.state === "pending" ? "expired" : it.state === "starting" || it.state === "running" ? "interrupted" : it.state;
      return {
        ...rest, state, tail: [],
        ...(it.result !== undefined ? { result: cap(it.result) } : {}),
        ...(it.error !== undefined ? { error: cap(it.error) } : {}),
      };
    }
    case "note": {
      const { images: _i, ...rest } = it;
      return it.state === "pending" ? { ...rest, state: "expired" } : rest;
    }
    case "todo":
      // Like a sprout card: one with a job id settles on restore; a tap never answered can't say. (A
      // "queued" card without one predates #923's report-back and stays as it was.)
      return it.state === "pending" ? { ...it, state: "expired" }
        : it.state === "sending" || (it.state === "running" && !it.jobId) ? { ...it, state: "done", result: SPROUT_UNKNOWN } : it;
    case "proposal":
    case "skill":
    case "offer":
      return it.state === "pending" ? { ...it, state: "expired" } : it;
    case "send": // main's pending proposal is gone after a reload
    case "routine":
      return it.state === "pending" || it.state === "sending" ? { ...it, state: "expired" } : it;
    case "sprout":
      // An admitted run keeps its job id and stays running: the restore settles it from main's record
      // (settleRestoredSprouts). Anything else running (a check, a start never answered) can't say.
      return it.state === "pending" ? { ...it, state: "expired" }
        : it.state === "running" && !it.jobId ? { ...it, state: "done", result: SPROUT_UNKNOWN } : it;
    case "status": {
      const { exiting: _e, ...rest } = it; // the child is long gone
      return { ...rest, text: cap(it.text) };
    }
    case "memory":
      return { ...it, state: it.state === "undone" ? "undone" : "kept" };
    case "forgot": // only the receipt's text — never the deleted row's other fields
      return { kind: "forgot", id: it.id, text: cap(it.text), state: it.state === "restored" ? "restored" : "kept" };
    case "continued": // known fields only; a malformed pointer is dropped, never half-kept
      return it.surface === "discord" && typeof it.conversationId === "string" && it.conversationId && typeof it.title === "string"
        ? { kind: "continued", id: it.id, surface: "discord", conversationId: it.conversationId.slice(0, 200), title: it.title.slice(0, 100) }
        : undefined;
    case "post": // known fields only, like `continued`: sprout output never brings extra keys back
      return typeof it.postId === "string" && typeof it.sprout === "string" && typeof it.at === "string" && typeof it.text === "string"
        ? {
          kind: "post", id: it.id, postId: it.postId.slice(0, 100), sprout: it.sprout.slice(0, 100), at: it.at.slice(0, 40), text: cap(it.text),
          ...(typeof it.batch === "string" ? { batch: it.batch.slice(0, 100) } : {}),
          // Kept in step with host chat.ts postShape: an unknown postKind is dropped, never half-kept.
          ...(it.postKind === "sprout" || it.postKind === "pulse" ? { postKind: it.postKind } : {}),
        }
        : undefined;
    case "summary":
      return typeof it.text === "string" && it.text ? { kind: "summary", id: it.id, text: cap(it.text) } : undefined;
    case "dm": // known fields only, like `post`: pulled DM text never brings extra keys back
      return Number.isSafeInteger(it.seq) && (it.via === "discord" || it.via === "teams") && typeof it.text === "string"
        && (it.role === "user" || it.role === "bean" || it.role === "agent" || it.role === "status")
        ? {
          kind: "dm", id: it.id, seq: it.seq, via: it.via, role: it.role, text: cap(it.text),
          ...(it.agent === "claude" || it.agent === "codex" || it.agent === "opencode" || it.agent === "agy" ? { agent: it.agent } : {}),
        }
        : undefined;
  }
}

/** The one fixed line atop a transcript the trim has dropped older items from (#976). A status row:
 * shown, saved, never model history. Shown as `trimNoticeText(<persona name>)` (#1001); the stored
 * text stays fixed, since it's how a notice is found again. */
export const trimNoticeText = (name: string): string => `Older messages aren't kept here — ${name} remembers what mattered.`;
export const TRIM_NOTICE = trimNoticeText("Bean");
const isTrimNotice = (it: ChatItem): boolean => it.kind === "status" && it.text === TRIM_NOTICE;

/** Drops the oldest items to at most `max` (and `maxBytes` as JSON) — never one `keep` holds, nor the
 * latest summary (#975), which stands for what was dropped. Once anything is dropped (now, or by an
 * earlier trim: `items` holds the notice), TRIM_NOTICE leads, counted in both bounds. `items` itself
 * when nothing can go, so a caller can tell "no change"; no byte limit = never serialized. */
function trimOldest(items: ChatItem[], max: number, keep: (it: ChatItem) => boolean, maxBytes = Infinity): ChatItem[] {
  const had = items.some(isTrimNotice);
  const all = items.filter((it) => !isTrimNotice(it));
  const s = all.findLastIndex((it) => it.kind === "summary");
  const droppable = all.flatMap((it, i) => (i === s || keep(it) ? [] : [i]));
  const view = (drop: number): ChatItem[] => {
    const gone = new Set(droppable.slice(0, drop));
    const body = all.filter((_, i) => !gone.has(i));
    return drop > 0 || had ? [{ kind: "status", id: "trim-notice", tone: "info", text: TRIM_NOTICE }, ...body] : body;
  };
  let drop = Math.min(droppable.length, all.length + (had ? 1 : 0) > max ? all.length + 1 - max : 0);
  const bytes = (xs: ChatItem[]): number => new TextEncoder().encode(JSON.stringify(xs)).length;
  // ponytail: re-encodes per drop of a tenth; fine at ≤500 items.
  while (maxBytes < Infinity && drop < droppable.length && bytes(view(drop)) > maxBytes) drop = Math.min(droppable.length, drop + Math.max(1, Math.floor((droppable.length - drop) / 10)));
  // Nothing dropped and the notice (if any) already one line on top: unchanged.
  const same = drop === 0 && (!had || (isTrimNotice(items[0]!) && all.length === items.length - 1));
  return same ? items : view(drop);
}

/** The transcript as it is saved: transient state dropped, actions made inert, each text capped, at
 * most THREAD_ITEMS_MAX items (oldest dropped) and under THREAD_MAX_BYTES as JSON. Only the latest
 * rolling summary is kept, and never trimmed away: cut past, it stays first after the notice,
 * standing for what was dropped (#975). Never mutates. */
export function normalizeForSave(items: readonly ChatItem[]): ChatItem[] {
  const all = items.flatMap((it) => normalizeItem(it) ?? []);
  const latest = all.findLastIndex((it) => it.kind === "summary");
  return trimOldest(all.filter((it, i) => it.kind !== "summary" || i === latest), THREAD_ITEMS_MAX, () => false, THREAD_MAX_BYTES);
}

/** How far past THREAD_ITEMS_MAX a live transcript grows before it's trimmed back, so a long-running
 * chat (Home never ends) trims now and then, not on every new item. */
export const THREAD_LIVE_SLACK = 50;
const UNSETTLED = new Set(["pending", "sending", "starting", "running", "queued", "undoing"]);
/** Still in motion: a card awaiting a tap or a run's end, a streaming reply, a turn in flight. */
const unsettled = (it: ChatItem): boolean => it.kind === "working" || (it.kind === "reply" && it.streaming === true)
  || (it.kind === "status" && it.exiting !== undefined) || ("state" in it && UNSETTLED.has(it.state));

/** The mounted transcript, bounded like the save (#976): past THREAD_ITEMS_MAX + THREAD_LIVE_SLACK
 * items, the oldest go down to THREAD_ITEMS_MAX — never an unsettled card or a post in `pending` (not
 * yet drained). The same array when under. */
export function boundLive(items: ChatItem[], pending: ReadonlySet<string>): ChatItem[] {
  return items.length <= THREAD_ITEMS_MAX + THREAD_LIVE_SLACK ? items
    : trimOldest(items, THREAD_ITEMS_MAX, (it) => unsettled(it) || (it.kind === "post" && pending.has(it.postId)));
}

const KINDS = new Set(["user", "reply", "working", "proposal", "delegate", "note", "skill", "offer", "todo", "sprout", "send", "routine", "status", "memory", "forgot", "continued", "post", "summary", "dm"]);

/** A saved transcript back into the window: well-formed items only, normalized again, fresh ids (a
 * restored `item-3` would collide with this load's counter), and user turns stripped of `source` —
 * restored turns are context, never citable by memory extraction again. */
export function restoreItems(saved: unknown): ChatItem[] {
  if (!Array.isArray(saved)) return [];
  const wellFormed = saved.filter((it): it is ChatItem => {
    const o = it as { kind?: unknown; id?: unknown } | null;
    return typeof o === "object" && o !== null && KINDS.has(o.kind as string) && typeof o.id === "string";
  });
  return normalizeForSave(wellFormed).map((it): ChatItem => {
    if (it.kind !== "user") return { ...it, id: newId() };
    const { source: _s, ...rest } = it;
    return { ...rest, id: newId() };
  });
}

export const pdfAskAgain = (name: string): string => `📄 ${name} isn't attached anymore — drop it again to keep asking about it.`;

/** The PDF a restored chat last attached (its placeholder), so the chat can ask for it again —
 * unless that ask is already in the transcript (a re-restore of a chat that was saved since). */
export function restoredPdf(items: readonly ChatItem[]): string | undefined {
  const later = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "status") later.add(it.text);
    const name = it.kind === "user" ? PDF_PLACEHOLDER_RE.exec(it.text)?.[1] : undefined;
    if (name) return later.has(pdfAskAgain(name)) ? undefined : name;
  }
  return undefined;
}

/** The Discord thread this chat continues in, if it was continued (the chat is then read-only). */
export const continuedTo = (items: readonly ChatItem[]): Extract<ChatItem, { kind: "continued" }> | undefined =>
  items.find((it): it is Extract<ChatItem, { kind: "continued" }> => it.kind === "continued");

/** A thread's title: the first message typed in it, one line, no model call. */
export function threadTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line || "New chat";
}

type SproutItem = Extract<ChatItem, { kind: "sprout" }>;
type TodoItem = Extract<ChatItem, { kind: "todo" }>;
/** A card waiting on a dispatch's end: a running sprout card, or a todo card run or queued (#923). */
const awaitsEnd = (it: ChatItem): it is (SproutItem | TodoItem) & { jobId: string } =>
  Boolean((it.kind === "sprout" && it.state === "running") || (it.kind === "todo" && (it.state === "running" || it.state === "queued")))
  && (it as { jobId?: string }).jobId !== undefined;
/** A sprout run's end, as its card and the chat learn it (main's `SproutOutcome` with a status). */
export interface SproutEnd { jobId: string; status: string; text: string }

/** The card's outcome line for a run's end. */
export function sproutResultLine(status: string): string {
  return status === "ok" ? "Finished" : status === "needs-attention" ? "Needs attention"
    : status === "interrupted" ? "Interrupted — Bean restarted before it finished, nothing was re-run" : "Failed";
}

/** The result turn a run's end loops back into its chat (#921), collapsed to a labelled row. A failed
 * or needs-attention run asks for a diagnosis and at most one confirm-first fix card instead (#1136). */
export function sproutLoopback(routine: string, end: SproutEnd): { text: string; display: string; source: "loopback" } {
  const ask = end.status === "failed" || end.status === "needs-attention"
    ? sproutFailureAsk(routine) : "Briefly summarize this outcome for the user in your own words.";
  return {
    text: `[sprout result for "${routine}"]: ${end.text}\n\n${ask}`,
    display: `🌱 Sprout "${routine}" — ${sproutResultLine(end.status).split(" — ")[0]!.toLowerCase()}`,
    source: "loopback",
  };
}

/** A run's end on its card: the running card with that job settles and its result loops back. Once
 * per job — a settled card (or one this chat doesn't hold) takes nothing, so a repeat is a no-op. */
export function applySproutEnd(items: ChatItem[], end: SproutEnd): { items: ChatItem[]; loopback?: ReturnType<typeof sproutLoopback> } {
  const match = items.find((it) => awaitsEnd(it) && it.jobId === end.jobId) as SproutItem | TodoItem | undefined;
  if (!match) return { items };
  return {
    items: items.map((it) => (it === match ? { ...match, state: "done" as const, result: sproutResultLine(end.status) } : it)),
    loopback: sproutLoopback(match.kind === "sprout" ? match.plan.routine : match.todo.routine, end),
  };
}

/** A restored chat's running sprout cards against main's record of its runs: an ended run settles
 * (and loops back, oldest first), one still running stays, and one main has no record of (pruned,
 * or another core's) can't say how it went. */
export function settleRestoredSprouts(
  items: ChatItem[], outcomes: ReadonlyArray<{ jobId: string; status?: string; text?: string }> | undefined,
): { items: ChatItem[]; loopbacks: ReturnType<typeof sproutLoopback>[]; changed: boolean } {
  let next = items;
  const loopbacks: ReturnType<typeof sproutLoopback>[] = [];
  let changed = false;
  for (const it of items) {
    if (!awaitsEnd(it)) continue;
    const o = outcomes?.find((x) => x.jobId === it.jobId);
    if (o && o.status === undefined) continue;
    changed = true;
    if (!o) {
      next = next.map((x) => (x.id === it.id ? { ...it, state: "done" as const, result: SPROUT_UNKNOWN } : x));
      continue;
    }
    const r = applySproutEnd(next, { jobId: o.jobId, status: o.status!, text: o.text ?? "" });
    next = r.items;
    if (r.loopback) loopbacks.push(r.loopback);
  }
  return { items: next, loopbacks, changed };
}

/** How long a quiet spell must be for the chat to mark where it resumed (#977). */
export const GAP_MS = 3 * 60 * 60 * 1000;
const atMs = (it: ChatItem): number => (it.kind === "user" || it.kind === "reply" || it.kind === "post") && it.at ? Date.parse(it.at) : NaN;

/** The time dividers (#977): item id → its `at`, for each item GAP_MS or more past the NEWEST
 * earlier timestamped item (not the one just above — a post lands later than its `at`). No earlier
 * time = no divider. Posts in a batch count one by one (ChatPanel draws theirs inside the fold). */
export function timeDividers(items: readonly ChatItem[]): Map<string, string> {
  const out = new Map<string, string>();
  let newest = -Infinity;
  for (const it of items) {
    const t = atMs(it);
    if (Number.isNaN(t)) continue;
    if (newest > -Infinity && t - newest >= GAP_MS) out.set(it.id, (it as { at: string }).at);
    newest = Math.max(newest, t);
  }
  return out;
}

/** Whether a message made at `at`, after `earlier`, gets a divider — so Bean gets the gap marker. */
export const resumesAfterGap = (earlier: readonly ChatItem[], at: string): boolean =>
  timeDividers([...earlier, { kind: "user", id: "\0next", text: "", at }]).has("\0next");

/** A divider's label, in the viewer's local time: absolute, never relative ("Thu, Nov 20 · 9:12 AM"). */
export const dividerLabel = (at: string): string => {
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
};

type PostIn = { id: string; sprout: string; body: string; createdAt: string; kind?: "pulse" };

/** A Home post as a chat item. Posts drained together share `batch`. */
export function postItem(p: PostIn, batch?: string): Extract<ChatItem, { kind: "post" }> {
  return {
    kind: "post", id: newId(), postId: p.id, sprout: p.sprout, at: p.createdAt, text: cap(p.body),
    ...(batch ? { batch } : {}), ...(p.kind === "pulse" ? { postKind: "pulse" as const } : {}),
  };
}

/** Posts not already in the transcript (by post id), as items — each run of 2+ consecutive sprout
 * posts is one batch. Bean's own check-ins (`pulse`) are never batched and split a run, so the fold
 * never reorders the transcript around one. */
export function newPostItems(items: readonly ChatItem[], posts: ReadonlyArray<PostIn>): ChatItem[] {
  const held = new Set(items.flatMap((it) => (it.kind === "post" ? [it.postId] : [])));
  const fresh = posts.filter((p) => !held.has(p.id));
  const out: ChatItem[] = [];
  for (let i = 0; i < fresh.length;) {
    if (fresh[i]!.kind === "pulse") { out.push(postItem(fresh[i]!)); i++; continue; }
    let j = i;
    while (j < fresh.length && fresh[j]!.kind !== "pulse") j++;
    const batch = j - i > 1 ? `batch-${fresh[i]!.id}` : undefined;
    for (; i < j; i++) out.push(postItem(fresh[i]!, batch));
  }
  return out;
}

/** A pull of the owner's DM exchanges (#1000), as the core hands it to Home (host `MainPull`). */
export interface MainPullView {
  rows: ReadonlyArray<{ seq: number; via: "discord" | "teams"; row: { role: "user" | "bean" | "agent" | "status"; text: string; agent?: LiveCli } }>;
  trimmed: boolean;
  cutover?: string;
}

/** Home's items with a pull applied: the cutover line once (by its text), each DM row once (by its log
 * seq) at the end in log order, and the trim notice on top when compaction overtook the cursor. The
 * same array when nothing changes. */
export function applyMainPull(items: ChatItem[], pull: MainPullView): ChatItem[] {
  const held = new Set(items.flatMap((it) => (it.kind === "dm" ? [it.seq] : [])));
  const add: ChatItem[] = [];
  if (pull.cutover && !items.some((it) => it.kind === "status" && it.text === pull.cutover)) {
    add.push({ kind: "status", id: newId(), tone: "info", text: pull.cutover });
  }
  for (const { seq, via, row } of pull.rows) {
    if (held.has(seq)) continue;
    add.push({ kind: "dm", id: newId(), seq, via, role: row.role, text: cap(row.text), ...(row.agent ? { agent: row.agent } : {}) });
  }
  const notice = pull.trimmed && !items.some(isTrimNotice);
  if (add.length === 0 && !notice) return items;
  return [...(notice ? [{ kind: "status", id: "trim-notice", tone: "info", text: TRIM_NOTICE } satisfies ChatItem] : []), ...items, ...add];
}
