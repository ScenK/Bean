import { useEffect, useRef, useState } from "preact/hooks";
import { ChatPanel } from "./ChatPanel.js";
import { newId, type ChatItem } from "../../shared/chat-types.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import type {
  ChatTurn, CliName, ImageAttachment, LinkedNote, Project, ProposedDelegate, ProposedNote, ProposedSkill, RouteSuggestion, Skill, TurnSource,
} from "@bean/core";
import type { DelegateEvent } from "../../../delegate-tasks.js";
import type { InterruptedRunNotice } from "../../../ipc.js";

// Closing with a delegate still running asks Keep/Stop first; everything else closes at once
// (memory is extracted in main after the window is gone). `null` = no card.
type CloseFlow = { stage: "delegates" } | null;

// Transcript handed to rememberOnClose: user turns keep their provenance (only "typed" ones are
// fact sources); replies are assistant turns.
export function closeTranscript(items: ChatItem[]): ChatTurn[] {
  return items
    .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
    .map((it) => (it.kind === "user"
      ? { role: "user" as const, content: it.text, source: it.source }
      : { role: "assistant" as const, content: it.text }));
}

type QueuedSend = { text: string; display?: string; source?: TurnSource };

export function markDelegateStarting(items: ChatItem[], id: string): ChatItem[] {
  return items.map((it) => (it.kind === "delegate" && it.id === id ? { ...it, state: "starting" as const } : it));
}

export function hasActiveDelegates(items: ChatItem[], pendingStarts: number): boolean {
  return pendingStarts > 0 || items.some((it) => it.kind === "delegate" && (it.state === "starting" || it.state === "running"));
}

export function addDelegateProposal(items: ChatItem[], proposal: ProposedDelegate, id: string): ChatItem[] {
  return [...items, { kind: "delegate", id, proposal, state: "pending", tail: [] }];
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
      source: "loopback",
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
  const [closeFlow, setCloseFlow] = useState<CloseFlow>(null);
  // Off the record: this chat is never remembered. Per window (a new chat starts off), read at
  // close — so switching it on mid-chat still covers the whole chat.
  const [incognito, setIncognito] = useState(false);
  const incognitoRef = useRef(false);
  incognitoRef.current = incognito;
  const [linkedNote, setLinkedNote] = useState<LinkedNote | undefined>(undefined);
  // Settings invalidates this catalog, so an already-open card immediately stops offering a
  // CLI the user just disabled.
  const { clis, models: runModels } = useCliAvailability();
  const [projects, setProjects] = useState<Project[]>([]);
  const [lastUsedModels, setLastUsedModels] = useState<Record<string, string>>({});
  // Full current skill list — passed to SkillCard so its "replaces existing" chip tracks
  // the user's live-edited name against real skills, not a stale server-computed flag.
  const [skills, setSkills] = useState<Skill[]>([]);
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
  // The mount effect below runs once, so it must reach sendMessage through a ref — a direct
  // reference would close over the first render's stale `busy`/`items`.
  const sendRef = useRef<(text: string, display?: string, queueIfBusy?: boolean, images?: ImageAttachment[], source?: TurnSource) => Promise<void>>(async () => {});

  useEffect(() => {
    const setTheme = (theme: string): void => {
      document.documentElement.dataset.theme = theme;
    };
    window.bean.getModel().then(setModel);
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.listProjects().then(setProjects);
    window.bean.listSkills().then(setSkills);
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
        await sendRef.current(p.prompt, `▶ ${p.label}`, false, undefined, "skill");
      })();
    };
    window.bean.getPendingChatPrompt().then((p) => { if (p) runPrompt(p); });
    window.bean.onChatPrompt(runPrompt);
    // A delegate run that was still going when Bean last quit gets reported here — pull +
    // push, same race fix as the dropped URL/chat prompt above. Rendered as a `reply` (not
    // `status`) so it enters conversation history: a later "retry" needs the full instruction
    // (notice.text) in context, not just the short bubble text (notice.display) shown on screen.
    const showInterruptedRunNotices = (notices: InterruptedRunNotice[]): void => {
      setItems((prev) => [
        ...prev,
        ...notices.map((n) => ({ kind: "reply" as const, id: newId(), text: n.text, display: n.display })),
      ]);
    };
    window.bean.getPendingInterruptedRunNotices().then((notices) => { if (notices?.length) showInterruptedRunNotices(notices); });
    window.bean.onInterruptedRunNotice(showInterruptedRunNotices);
    window.bean.onDelegateEvent(applyDelegateEvent);
    // generate_image started inside the current turn — flip the working bubble so the
    // (up to a minute) wait reads as painting, not a hang.
    window.bean.onChatImageProgress(() => {
      setItems((prev) => prev.map((it) => (it.kind === "working" ? { ...it, text: "🎨 Painting" } : it)));
    });
    window.bean.onReviewBeforeClose(() => {
      if (hasActiveDelegates(itemsRef.current, pendingDelegateStartsRef.current.size)) {
        setCloseFlow({ stage: "delegates" });
        return;
      }
      closeNow();
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

  const sendMessage = async (
    text: string, display?: string, queueIfBusy = false, images?: ImageAttachment[], source: TurnSource = "typed",
  ): Promise<void> => {
    const message = text.trim();
    if (!message) return;
    if (busyRef.current) {
      if (queueIfBusy) queuedSendsRef.current.push({ text: message, display, source });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setStatus("working");
    const workingId = newId();
    setItems((prev) => [...prev, {
      kind: "user", id: newId(), text: message, display, source,
      images: images?.map((i) => `data:${i.mimeType};base64,${i.data}`),
    }, { kind: "working", id: workingId, text: "Spinning up" }]);

    // Image bytes ride only on the current turn; older turns keep a text placeholder
    // (mirrors chatops — see core's latestUserImages doc comment).
    const history: ChatTurn[] = itemsRef.current
      .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
      .map((it) => ({
        role: it.kind === "user" ? "user" : "assistant",
        content: it.kind === "user" && it.images?.length ? `${it.text}\n[image attached]` : it.text,
        source: it.kind === "user" ? it.source : undefined,
      }));

    try {
      const res = await window.bean.chat({ history, message, source, incognito: incognitoRef.current, linkedNote: linkedNoteRef.current, images });
      if (res.model) setModel(res.model);

      setItems((prev) => {
        const next = prev.filter((it) => it.id !== workingId);
        const generated = res.generatedImages?.filter(
          (g): g is { path: string; dataUrl: string } => typeof g.dataUrl === "string",
        );
        if (res.reply.trim() || generated?.length) {
          next.push({ kind: "reply", id: newId(), text: res.reply, images: generated?.length ? generated : undefined });
        }
        if (res.proposedRun) {
          next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
          const skillName = res.proposedRun.skillName;
          void window.bean.getModelMemory(skillName).then((modelId) => {
            if (modelId) setLastUsedModels((prev) => ({ ...prev, [skillName]: modelId }));
          });
        }
        if (res.proposedNote) next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending" });
        if (res.proposedSkill) next.push({ kind: "skill", id: newId(), skill: res.proposedSkill, state: "pending" });
        if (res.proposedTodo) next.push({ kind: "todo", id: newId(), todo: res.proposedTodo, state: "pending" });
        if (res.proposedDelegate) next.push(...addDelegateProposal([], res.proposedDelegate, newId()));
        for (const m of res.remembered ?? []) next.push({ kind: "status", id: newId(), text: `🧠 Remembered — ${m.text}`, tone: "done" });
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
      if (next) void sendMessage(next.text, next.display, true, undefined, next.source);
    }
  };
  sendRef.current = sendMessage;

  const confirmProposal = (
    id: string,
    editedPrompt: string,
    run: RouteSuggestion,
    choice: { cli?: CliName; projectPath?: string; model?: string },
  ): void => {
    const inChat = run.target === "chat";
    if (!inChat && !choice.cli) return;
    setItems((prev) => [
      ...prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "confirmed" as const } : it)),
      { kind: "status", id: newId(), text: inChat ? "Running here…" : "Handed off to Terminal.", tone: "done" },
    ]);
    if (choice.model) void window.bean.setModelMemory(run.skillName, choice.model);
    if (inChat) {
      void sendMessage(editedPrompt, `▶ ${run.skillName}`, false, undefined, "skill");
      return;
    }
    window.bean.launch({
      mode: choice.cli!,
      projectPath: choice.projectPath ?? "",
      prompt: editedPrompt,
      model: choice.model,
    });
  };

  const cancelProposal = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "cancelled" } : it)));
  };

  const startDelegate = async (id: string, projectPath: string, prompt: string, instruction: string, model?: string): Promise<void> => {
    if (pendingDelegateStartsRef.current.has(id)) return;
    const start = window.bean.delegateStart({ projectPath, prompt, instruction, model });
    pendingDelegateStartsRef.current.set(id, start);
    setItems((prev) => markDelegateStarting(prev, id));
    try {
      const taskId = await start;
      delegateTaskIdsRef.current.set(id, taskId);
      const buffered = pendingDelegateEventsRef.current.get(taskId) ?? [];
      pendingDelegateEventsRef.current.delete(taskId);
      const result = attachDelegateTaskId(itemsRef.current, id, taskId, prompt, buffered);
      setItems(result.items);
      for (const loopback of result.loopbacks) void sendRef.current(loopback.text, loopback.display, true, undefined, loopback.source);
    } finally {
      pendingDelegateStartsRef.current.delete(id);
    }
  };

  const confirmDelegate = async (id: string, editedPrompt: string, model?: string): Promise<void> => {
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    if (!item || (item.state !== "pending" && item.state !== "starting")) return;
    return startDelegate(id, item.proposal.projectPath, editedPrompt, item.proposal.instruction, model);
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

  const saveSkill = async (id: string, edited: ProposedSkill): Promise<void> => {
    try {
      await window.bean.saveSkill(edited.name, edited.body);
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "skill" ? { ...it, state: "saved" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Saved skill — "${edited.name}"`, tone: "done" },
      ]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't save the skill: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissSkill = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "skill" ? { ...it, state: "dismissed" } : it)));
  };

  const queueTodo = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "todo" }> => it.kind === "todo" && it.id === id);
    if (!item) return;
    try {
      await window.bean.todosAdd(item.todo.routine, item.todo.text);
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "todo" ? { ...it, state: "queued" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Queued on "${item.todo.routine}"`, tone: "done" },
      ]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't queue the todo: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissTodo = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "todo" ? { ...it, state: "dismissed" } : it)));
  };

  // Composer's 📝 button: an explicit ask, so the model drafts the confirm card even when it
  // wouldn't have offered on its own.
  const saveToNotes = (): void => {
    void sendMessage("Save this conversation as a note (use the propose_note tool).", "📝 Save to notes", false, undefined, "skill");
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
    if (loopback) void sendRef.current(loopback.text, loopback.display, true, undefined, loopback.source);
  };

  // Hand the transcript to main (fire-and-forget) and close immediately — no review card.
  // Main extracts in the background; Undo lives in Persona via the avatar bubble.
  const closeNow = (): void => {
    setCloseFlow(null);
    const transcript = closeTranscript(itemsRef.current);
    if (transcript.length > 0) window.bean.rememberOnClose(transcript, { incognito: incognitoRef.current });
    window.bean.allowChatClose();
  };

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
    closeNow();
  };

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
      <ChatPanel
        items={items}
        busy={busy}
        model={model}
        status={status}
        prefillUrl={droppedUrl}
        linkedNote={linkedNote}
        clis={clis}
        projects={projects}
        runModels={runModels}
        lastUsedModels={lastUsedModels}
        skills={skills}
        onSend={(text, images) => void sendMessage(text, undefined, false, images)}
        onConfirm={confirmProposal}
        onCancel={cancelProposal}
        onNoteSave={(id, edited, asNew) => void saveNote(id, edited, asNew)}
        onNoteDismiss={dismissNote}
        onSkillSave={(id, edited) => void saveSkill(id, edited)}
        onSkillDismiss={dismissSkill}
        onTodoQueue={(id) => void queueTodo(id)}
        onTodoDismiss={dismissTodo}
        onDelegateConfirm={(id, edited, model) => void confirmDelegate(id, edited, model)}
        onDelegateDismiss={dismissDelegate}
        onDelegateCancelTask={cancelDelegateTask}
        onSaveToNotes={saveToNotes}
        onUnlink={() => setLinkedNote(undefined)}
        incognito={incognito}
        onToggleIncognito={() => setIncognito((v) => !v)}
      />
    </div>
  );
}
