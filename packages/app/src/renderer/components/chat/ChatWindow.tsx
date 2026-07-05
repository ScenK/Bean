import { useEffect, useRef, useState } from "preact/hooks";
import { ChatPanel } from "./ChatPanel.js";
import { newId, type ChatItem } from "../../shared/chat-types.js";
import type { ChatTurn, LinkedNote, MemoryCandidate, Memory, ProposedNote, RouteSuggestion } from "@bean/core";
import type { DelegateEvent } from "../../../delegate-tasks.js";

// Extraction is a real LLM call — a reasoning model (e.g. gpt-5-mini) routinely takes ~5s and
// longer for bigger transcripts. This is only a backstop against a genuinely hung request, so it
// must comfortably exceed real latency; a too-short value silently discards valid memories (the
// promise loses the race and resolves to []), which is exactly the bug this replaced.
const REVIEW_TIMEOUT_MS = 20000;
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// Drives the "before I go" card shown when the chat window closes with a non-empty
// transcript: ask first (no LLM call yet, so the wait that follows is expected rather than
// a silent hang) → loading (extraction in flight) → review (pick which candidates to keep).
// `null` means no card — the window closes normally.
type CloseFlow =
  | { stage: "delegates" }
  | { stage: "confirm" }
  | { stage: "loading" }
  | { stage: "review"; items: { text: string; projectPath?: string; checked: boolean }[] };

type QueuedSend = { text: string; display?: string };

export function markDelegateStarting(items: ChatItem[], id: string): ChatItem[] {
  return items.map((it) => (it.kind === "delegate" && it.id === id ? { ...it, state: "starting" as const } : it));
}

export function hasActiveDelegates(items: ChatItem[], pendingStarts: number): boolean {
  return pendingStarts > 0 || items.some((it) => it.kind === "delegate" && (it.state === "starting" || it.state === "running"));
}

export function applyDelegateEventToItems(
  items: ChatItem[],
  e: DelegateEvent,
): { items: ChatItem[]; loopback?: QueuedSend } {
  const match = items.find(
    (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.taskId === e.taskId,
  );
  if (!match) return { items };
  return {
    items: items.map((it) => {
      if (it.kind !== "delegate" || it.taskId !== e.taskId) return it;
      if (e.type === "output") return { ...it, tail: [...it.tail.slice(-29), e.line] };
      if (e.type === "done") return { ...it, state: "done" as const, result: e.result };
      if (e.type === "failed") return { ...it, state: "failed" as const, error: e.message };
      if (e.type === "cancelled") return { ...it, state: "cancelled" as const };
      return it;
    }),
    loopback: e.type === "done" ? {
      text: `[delegate result for "${match.proposal.instruction}"]: ${e.result}\n\nBriefly summarize this outcome for the user in your own words.`,
      display: "📦 Delegate finished",
    } : undefined,
  };
}

export function attachDelegateTaskId(
  items: ChatItem[],
  id: string,
  taskId: string,
  instruction: string,
  buffered: DelegateEvent[],
): { items: ChatItem[]; loopbacks: QueuedSend[] } {
  let next = items.map((it) => (
    it.kind === "delegate" && it.id === id ? { ...it, state: "running" as const, taskId, proposal: { ...it.proposal, instruction } } : it
  ));
  const loopbacks: QueuedSend[] = [];
  for (const event of buffered) {
    const result = applyDelegateEventToItems(next, event);
    next = result.items;
    if (result.loopback) loopbacks.push(result.loopback);
  }
  return { items: next, loopbacks };
}

export function ChatWindow() {
  const [droppedUrl, setDroppedUrl] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("model");
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [closeFlow, setCloseFlow] = useState<CloseFlow | null>(null);
  const [linkedNote, setLinkedNote] = useState<LinkedNote | undefined>(undefined);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  const busyRef = useRef(false);
  const queuedSendsRef = useRef<QueuedSend[]>([]);
  const pendingDelegateStartsRef = useRef(new Map<string, Promise<string>>());
  const delegateTaskIdsRef = useRef(new Map<string, string>());
  const pendingDelegateEventsRef = useRef(new Map<string, DelegateEvent[]>());
  // sendMessage is reached via sendRef from the once-mounted effect, so it reads the linked
  // note through a ref too — state alone would be a stale closure there.
  const linkedNoteRef = useRef<LinkedNote | undefined>(undefined);
  linkedNoteRef.current = linkedNote;
  // Captured once when the confirm card appears; `confirmExtract` reads it later, after the
  // user has clicked "Extract" — a ref (not state) so the click handler always sees the
  // transcript as of close time, not whatever `items` has become since.
  const closeTranscriptRef = useRef<ChatTurn[]>([]);
  // The mount effect below runs once, so it must reach sendMessage through a ref — a direct
  // reference would close over the first render's stale `busy`/`items`.
  const sendRef = useRef<(text: string, display?: string, queueIfBusy?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    const setTheme = (theme: string): void => {
      document.documentElement.dataset.theme = theme;
    };
    window.bean.getModel().then(setModel);
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    // Pull any URL dropped before this window's renderer finished mounting — the push below
    // (onComponentDroppedUrl) can arrive first and gets silently dropped, same race
    // getPendingPlan fixes for the Plan window.
    window.bean.getPendingDroppedUrl().then((u) => { if (u) setDroppedUrl(u); });
    window.bean.onComponentDroppedUrl(setDroppedUrl);
    // A chat-target skill run confirmed in the Plan popup: auto-send its composed prompt,
    // collapsed to `▶ label` in the transcript. Pull + push, same race fix as the dropped URL.
    const runPrompt = (p: { prompt: string; label: string; noteSlug?: string }): void => {
      void (async () => {
        // "Continue in chat" from a note: link this chat to it before the first send so the
        // note body rides along in the system prompt and saves default to update-in-place.
        if (p.noteSlug) {
          const note = (await window.bean.listNotes()).find((n) => n.slug === p.noteSlug);
          if (note) {
            const linked = { slug: note.slug, title: note.title, version: note.version, body: note.body };
            linkedNoteRef.current = linked;
            setLinkedNote(linked);
          }
        }
        await sendRef.current(p.prompt, `▶ ${p.label}`);
      })();
    };
    window.bean.getPendingChatPrompt().then((p) => { if (p) runPrompt(p); });
    window.bean.onChatPrompt(runPrompt);
    window.bean.onDelegateEvent(applyDelegateEvent);
    window.bean.onReviewBeforeClose(() => {
      const transcript: ChatTurn[] = itemsRef.current
        .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
        .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));
      closeTranscriptRef.current = transcript;
      if (hasActiveDelegates(itemsRef.current, pendingDelegateStartsRef.current.size)) {
        setCloseFlow({ stage: "delegates" });
        return;
      }
      if (transcript.length === 0) { window.bean.allowChatClose(); return; }
      setCloseFlow({ stage: "confirm" });
    });
  }, []);

  // ChatPanel's prefill effect fires on a change to `droppedUrl` — flipping it back to
  // undefined right after handoff means a later drop of that exact same path is still a real
  // undefined→value transition (and so still prefills), not a no-op repeat of an unchanged prop.
  useEffect(() => {
    if (droppedUrl === undefined) return;
    const t = setTimeout(() => setDroppedUrl(undefined), 0);
    return () => clearTimeout(t);
  }, [droppedUrl]);

  const sendMessage = async (text: string, display?: string, queueIfBusy = false): Promise<void> => {
    const message = text.trim();
    if (!message) return;
    if (busyRef.current) {
      if (queueIfBusy) queuedSendsRef.current.push({ text: message, display });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setStatus("working");
    const workingId = newId();
    setItems((prev) => [...prev, { kind: "user", id: newId(), text: message, display }, { kind: "working", id: workingId, text: "Spinning up" }]);

    const history: ChatTurn[] = itemsRef.current
      .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
      .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));

    try {
      const res = await window.bean.chat({ history, message, linkedNote: linkedNoteRef.current });
      if (res.model) setModel(res.model);

      setItems((prev) => {
        const next = prev.filter((it) => it.id !== workingId);
        if (res.reply.trim()) next.push({ kind: "reply", id: newId(), text: res.reply });
        if (res.proposedRun) next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
        if (res.proposedNote) next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending" });
        if (res.proposedDelegate) next.push({ kind: "delegate", id: newId(), proposal: res.proposedDelegate, state: "pending", tail: [] });
        return next;
      });
      setStatus("idle");
    } catch {
      setItems((prev) => [...prev.filter((it) => it.id !== workingId), { kind: "status", id: newId(), text: "Failed to reach Bean.", tone: "error" }]);
      setStatus("error");
    } finally {
      busyRef.current = false;
      setBusy(false);
      const next = queuedSendsRef.current.shift();
      if (next) void sendMessage(next.text, next.display, true);
    }
  };
  sendRef.current = sendMessage;

  const confirmProposal = (id: string, editedPrompt: string, run: RouteSuggestion): void => {
    const inChat = run.target === "chat";
    setItems((prev) => [
      ...prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "confirmed" as const } : it)),
      { kind: "status", id: newId(), text: inChat ? "Running here…" : "Handed off to Terminal.", tone: "done" },
    ]);
    if (inChat) {
      void sendMessage(editedPrompt, `▶ ${run.skillName}`);
      return;
    }
    window.bean.launch({ mode: "opencode", projectPath: run.projectPath, prompt: editedPrompt });
  };

  const cancelProposal = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "cancelled" } : it)));
  };

  const confirmDelegate = async (id: string, editedPrompt: string): Promise<void> => {
    if (pendingDelegateStartsRef.current.has(id)) return;
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    if (!item || item.state !== "pending") return;
    const start = window.bean.delegateStart({ projectPath: item.proposal.projectPath, prompt: editedPrompt });
    pendingDelegateStartsRef.current.set(id, start);
    setItems((prev) => markDelegateStarting(prev, id));
    try {
      const taskId = await start;
      delegateTaskIdsRef.current.set(id, taskId);
      const buffered = pendingDelegateEventsRef.current.get(taskId) ?? [];
      pendingDelegateEventsRef.current.delete(taskId);
      const result = attachDelegateTaskId(itemsRef.current, id, taskId, editedPrompt, buffered);
      setItems(result.items);
      for (const loopback of result.loopbacks) void sendRef.current(loopback.text, loopback.display, true);
    } finally {
      pendingDelegateStartsRef.current.delete(id);
    }
  };

  const dismissDelegate = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "delegate" ? { ...it, state: "dismissed" as const } : it)));
  };

  const cancelDelegateTask = (id: string): void => {
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    const taskId = item?.taskId ?? delegateTaskIdsRef.current.get(id);
    if (taskId) window.bean.delegateCancel(taskId);
  };

  const saveNote = async (id: string, edited: ProposedNote, asNew: boolean): Promise<void> => {
    try {
      const slug = await window.bean.saveNote({
        title: edited.title,
        body: edited.body,
        project: edited.project,
        slug: asNew ? undefined : edited.slug,
        source: "chat",
      });
      // Keep the linked chip current after an in-place update (v3 → v4).
      if (!asNew && edited.slug !== undefined) {
        const fresh = (await window.bean.listNotes()).find((n) => n.slug === slug);
        if (fresh) setLinkedNote({ slug: fresh.slug, title: fresh.title, version: fresh.version, body: fresh.body });
      }
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "note" ? { ...it, state: "saved" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Saved to Notes — "${edited.title}"`, tone: "done" },
      ]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't save the note: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissNote = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "note" ? { ...it, state: "dismissed" } : it)));
  };

  // Composer's 📝 button: an explicit ask, so the model drafts the confirm card even when it
  // wouldn't have offered on its own.
  const saveToNotes = (): void => {
    void sendMessage("Save this conversation as a note (use the propose_note tool).", "📝 Save to notes");
  };

  const applyDelegateEvent = (e: DelegateEvent): void => {
    const { loopback } = applyDelegateEventToItems(itemsRef.current, e);
    if (!itemsRef.current.some((it) => it.kind === "delegate" && it.taskId === e.taskId)) {
      pendingDelegateEventsRef.current.set(e.taskId, [...(pendingDelegateEventsRef.current.get(e.taskId) ?? []), e]);
      return;
    }
    if (e.type === "done" || e.type === "failed" || e.type === "cancelled") {
      for (const [id, taskId] of delegateTaskIdsRef.current) {
        if (taskId === e.taskId) delegateTaskIdsRef.current.delete(id);
      }
      pendingDelegateEventsRef.current.delete(e.taskId);
    }
    setItems((prev) => applyDelegateEventToItems(prev, e).items);
    if (loopback) void sendRef.current(loopback.text, loopback.display, true);
  };

  // Shared by the confirm-stage "Skip" and the review-stage "Skip" — both mean "close with
  // no write", they just fire from different stages of the same flow.
  const dismissClose = (): void => { setCloseFlow(null); window.bean.allowChatClose(); };

  const keepWorking = (): void => setCloseFlow(null);

  const stopDelegatesAndClose = async (): Promise<void> => {
    await Promise.allSettled(pendingDelegateStartsRef.current.values());
    const cancelled = new Set<string>();
    for (const taskId of delegateTaskIdsRef.current.values()) {
      cancelled.add(taskId);
      window.bean.delegateCancel(taskId);
    }
    for (const it of itemsRef.current) {
      if (it.kind !== "delegate" || (it.state !== "starting" && it.state !== "running")) continue;
      const taskId = it.taskId ?? delegateTaskIdsRef.current.get(it.id);
      if (taskId && !cancelled.has(taskId)) {
        cancelled.add(taskId);
        window.bean.delegateCancel(taskId);
      }
    }
    if (closeTranscriptRef.current.length === 0) { dismissClose(); return; }
    setCloseFlow({ stage: "confirm" });
  };

  const confirmExtract = (): void => {
    setCloseFlow({ stage: "loading" });
    void withTimeout(window.bean.extractMemories(closeTranscriptRef.current), REVIEW_TIMEOUT_MS, [] as MemoryCandidate[])
      .then((candidates) => {
        if (candidates.length === 0) { dismissClose(); return; }
        setCloseFlow({
          stage: "review",
          items: candidates.map((c) => ({ text: c.text, projectPath: c.projectPath, checked: true })),
        });
      })
      .catch(dismissClose);
  };

  const rememberSelected = async (): Promise<void> => {
    const picked = (closeFlow?.stage === "review" ? closeFlow.items : []).filter((r) => r.checked);
    if (picked.length > 0) {
      const existing = await window.bean.listMemories();
      const now = new Date().toISOString();
      const additions: Memory[] = picked.map((r, i) => ({
        id: `${Date.now()}-${i}`,
        text: r.text,
        projectPath: r.projectPath,
        createdAt: now,
      }));
      await window.bean.saveMemories([...existing, ...additions]);
    }
    setCloseFlow(null);
    window.bean.allowChatClose();
  };
  const toggleReview = (idx: number): void =>
    setCloseFlow((prev) =>
      prev?.stage === "review"
        ? { ...prev, items: prev.items.map((r, i) => (i === idx ? { ...r, checked: !r.checked } : r)) }
        : prev,
    );

  return (
    <div class="bean-dashboard bean-chat-window">
      {closeFlow?.stage === "delegates" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">A delegated task is still running — closing will stop it.</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={keepWorking}>Keep working</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={stopDelegatesAndClose}>Stop & close</button>
            </div>
          </div>
        </div>
      ) : null}
      {closeFlow?.stage === "confirm" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Before I go — want me to look for things to remember?</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={confirmExtract}>Extract</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={dismissClose}>Skip</button>
            </div>
          </div>
        </div>
      ) : null}
      {closeFlow?.stage === "loading" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-loading">Thinking about what to remember…</div>
          </div>
        </div>
      ) : null}
      {closeFlow?.stage === "review" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Before I go — remember these?</div>
            {closeFlow.items.map((r, i) => (
              <label key={i} class="bean-memory-review-row">
                <input type="checkbox" checked={r.checked} onChange={() => toggleReview(i)} />
                <span>{r.text}{r.projectPath ? <em class="bean-memory-review-tag"> · project</em> : null}</span>
              </label>
            ))}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void rememberSelected()}>Remember</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={dismissClose}>Skip</button>
            </div>
          </div>
        </div>
      ) : null}
      <ChatPanel
        items={items}
        busy={busy}
        model={model}
        status={status}
        prefillUrl={droppedUrl}
        linkedNote={linkedNote}
        onSend={sendMessage}
        onConfirm={confirmProposal}
        onCancel={cancelProposal}
        onNoteSave={(id, edited, asNew) => void saveNote(id, edited, asNew)}
        onNoteDismiss={dismissNote}
        onDelegateConfirm={(id, edited) => void confirmDelegate(id, edited)}
        onDelegateDismiss={dismissDelegate}
        onDelegateCancelTask={cancelDelegateTask}
        onSaveToNotes={saveToNotes}
        onUnlink={() => setLinkedNote(undefined)}
      />
    </div>
  );
}
