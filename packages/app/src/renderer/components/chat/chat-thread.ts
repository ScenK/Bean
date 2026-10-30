import { newId, type ChatItem } from "../../shared/chat-types.js";

// A desktop chat thread's saved form — pure and node-free, so it tests without a DOM. Every save and
// every restore passes through normalizeForSave: nothing transient (task ids, live session ids,
// streaming flags, image bytes) reaches bean.db, and nothing restored can act — pending cards come
// back "expired", running work "interrupted", memory rows without Undo. See
// .memory/project-desktop-chat-history.md.

export const THREAD_TEXT_MAX = 20_000;
export const THREAD_ITEMS_MAX = 500;
// Renderer copy of core's DESKTOP_CHAT_MAX_BYTES (node-free bundle rule) — keep in step.
export const THREAD_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_PLACEHOLDER = "[image attached]";
const TITLE_MAX = 60;

const cap = (s: string): string => (s.length > THREAD_TEXT_MAX ? `${s.slice(0, THREAD_TEXT_MAX)}…` : s);
const withPlaceholder = (text: string, had: boolean): string => (had ? `${text}\n${IMAGE_PLACEHOLDER}` : text);

function normalizeItem(it: ChatItem): ChatItem | undefined {
  switch (it.kind) {
    case "working":
      return undefined;
    case "user": {
      const { images, ...rest } = it;
      return { ...rest, text: cap(withPlaceholder(it.text, !!images?.length)), ...(it.display !== undefined ? { display: cap(it.display) } : {}) };
    }
    case "reply": {
      const { images, session: _s, tail: _t, streaming, ...rest } = it;
      return {
        ...rest,
        text: cap(withPlaceholder(it.text, !!images?.length)),
        ...(it.display !== undefined ? { display: cap(it.display) } : {}),
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
    case "proposal":
    case "skill":
    case "todo":
    case "offer":
      return it.state === "pending" ? { ...it, state: "expired" } : it;
    case "status": {
      const { exiting: _e, ...rest } = it; // the child is long gone
      return { ...rest, text: cap(it.text) };
    }
    case "memory":
      return { ...it, state: it.state === "undone" ? "undone" : "kept" };
  }
}

/** The transcript as it is saved: transient state dropped, actions made inert, each text capped, at
 * most THREAD_ITEMS_MAX items (oldest dropped) and under THREAD_MAX_BYTES as JSON. Never mutates. */
export function normalizeForSave(items: readonly ChatItem[]): ChatItem[] {
  let out = items.flatMap((it) => normalizeItem(it) ?? []).slice(-THREAD_ITEMS_MAX);
  const bytes = (xs: ChatItem[]): number => new TextEncoder().encode(JSON.stringify(xs)).length;
  // ponytail: re-encodes per drop of a tenth; fine at ≤500 items.
  while (out.length > 0 && bytes(out) > THREAD_MAX_BYTES) out = out.slice(Math.max(1, Math.floor(out.length / 10)));
  return out;
}

const KINDS = new Set(["user", "reply", "working", "proposal", "delegate", "note", "skill", "offer", "todo", "status", "memory"]);

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

/** A thread's title: the first message typed in it, one line, no model call. */
export function threadTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line || "New chat";
}
