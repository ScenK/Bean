import { useEffect, useRef, useState } from "preact/hooks";
import { ChatPanel } from "./ChatPanel.js";
import { newId, type AgentId, type ChatItem } from "../../shared/chat-types.js";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import { chatTurns, handoffItems, handoffLines, ensureStreaming, applyLiveEvent, isLiveAgent, offerAgent } from "./agent-mode.js";
import { resolveSlash, terminalDestination } from "./slash-commands.js";
import { composePrompt } from "@bean/core/prompt";
import { useCliAvailability } from "../../shared/cli-availability.js";
import { dataUrlToAttachment } from "../../shared/note-images.js";
import type {
  CliName, ImageAttachment, LiveCli, LinkedNote, Project, ProposedDelegate, ProposedNote, ProposedSkill, Routine, RouteSuggestion, Skill, TurnSource,
} from "@bean/core";
import type { DelegateEvent } from "../../../delegate-tasks.js";
import type { LiveEvent, LiveReceipt, LiveStartResult } from "../../../live-tasks.js";
import type { CloseTurn, InterruptedRunNotice } from "../../../ipc.js";

// Closing with a delegate still running asks Keep/Stop first; everything else closes at once
// (memory is extracted in main after the window is gone). `null` = no card.
type CloseFlow = { stage: "delegates" } | null;

// Transcript handed to rememberOnClose — see chatTurns (live steering and agent finals stay out).
export const closeTranscript = (items: ChatItem[]): CloseTurn[] => chatTurns(items, { memory: true });

/** The window's agent session. `key` tells a start apart from a later one; `sessionId` arrives with
 * the `started` event (or liveStart's result); texts typed before it are `queued`. `continuing` =
 * resumed from a receipt (Continue live). `receipt` = the CLI's own session, from the `session` event. */
interface LiveState {
  key: string; agent: LiveCli; projectPath: string; sessionId?: string; turns: number; busy: boolean; queued: string[];
  continuing?: boolean; receipt?: LiveReceipt;
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
      const receipt = e.type !== "started" && e.receipt ? { receipt: e.receipt } : {};
      if (e.type === "done") return { ...it, state: "done" as const, result: e.result, ...receipt };
      if (e.type === "failed") return { ...it, state: "failed" as const, error: e.message, ...receipt };
      if (e.type === "cancelled") return { ...it, state: "cancelled" as const, ...receipt };
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
  // Off the record: per window (a new chat starts off). Read at close, and mirrored to main so it
  // also stops per-turn captures still in flight. Facts captured before it was switched on stay
  // saved — their "Memory updated" rows keep Undo.
  const [incognito, setIncognito] = useState(false);
  const incognitoRef = useRef(false);
  incognitoRef.current = incognito;
  // Sent from the toggle itself, not an effect: a close right after the click must not beat it.
  const toggleIncognito = (): void => {
    const on = !incognitoRef.current;
    incognitoRef.current = on;
    window.bean.setChatIncognito(on);
    setIncognito(on);
  };
  // Facts undone from a "Memory updated" row — handed to close catch-up so it won't re-save them.
  const rejectedMemoriesRef = useRef<string[]>([]);
  const [linkedNote, setLinkedNote] = useState<LinkedNote | undefined>(undefined);
  // Settings invalidates this catalog, so an already-open card immediately stops offering a
  // CLI the user just disabled.
  const { clis, models: runModels } = useCliAvailability();
  const [projects, setProjects] = useState<Project[]>([]);
  const [lastUsedModels, setLastUsedModels] = useState<Record<string, string>>({});
  // Full current skill list — passed to SkillCard so its "replaces existing" chip tracks
  // the user's live-edited name against real skills, not a stale server-computed flag.
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sprouts, setSprouts] = useState<Routine[]>([]);
  const [delegateCli, setDelegateCli] = useState("");
  // The `/` menu's catalogs — refreshed each time the menu opens. A terminal skill's caption names
  // its delegate destination, so its remembered model and the Settings CLI preference come too.
  const refreshCatalogs = (): void => {
    window.bean.listSkills().then((s) => {
      setSkills(s ?? []);
      // ponytail: one IPC per terminal skill; add a bulk model-memory getter if skill lists grow large.
      for (const k of s ?? []) {
        if (k.target === "chat") continue;
        void window.bean.getModelMemory(k.name).then((m) => { if (m) setLastUsedModels((prev) => ({ ...prev, [k.name]: m })); }, () => {});
      }
    }, () => {});
    window.bean.routinesList().then((r) => setSprouts(r ?? []), () => {});
    window.bean.getConfig().then((c) => setDelegateCli(c?.delegateCli ?? ""), () => {});
  };
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  // Agent mode: who answers typed composer text. A pick only switches; the agent spawns on the
  // first typed send. Refs mirror state for the once-mounted live-event listener.
  const [mode, setModeState] = useState<AgentId>("bean");
  const modeRef = useRef<AgentId>("bean");
  const setMode = (m: AgentId): void => { modeRef.current = m; setModeState(m); };
  // The last project used in this window ("" = Bean's scratch workspace) — never projects[0].
  const [agentProject, setAgentProjectState] = useState("");
  const agentProjectRef = useRef("");
  const rememberProject = (path: string): void => { agentProjectRef.current = path; setAgentProjectState(path); };
  const [live, setLiveState] = useState<LiveState | undefined>(undefined);
  const liveRef = useRef<LiveState | undefined>(undefined);
  const setLive = (l: LiveState | undefined): void => { liveRef.current = l; setLiveState(l); };
  // Sessions this window adopted — events from any other (a start abandoned mid-startup) are ignored.
  const knownSessionsRef = useRef(new Set<string>());
  // Hand-off offers already started (startOffer's claim-once guard).
  const offersClaimedRef = useRef(new Set<string>());
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
  const liveEventRef = useRef<(e: LiveEvent) => void>(() => {});

  useEffect(() => {
    const setTheme = (theme: string): void => {
      document.documentElement.dataset.theme = theme;
    };
    window.bean.getModel().then(setModel);
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.listProjects().then(setProjects);
    refreshCatalogs();
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
          // Default listNotes() hides archived notes, so an archived note is never linked.
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
    window.bean.onLiveEvent((e) => liveEventRef.current(e));
    window.bean.onMemoryUpdated((saved) => {
      setItems((prev) => [...prev, { kind: "memory", id: newId(), saved, state: "saved" }]);
    });
    // generate_image started inside the current turn — flip the working bubble so the
    // (up to a minute) wait reads as painting, not a hang.
    window.bean.onChatImageProgress(() => {
      setItems((prev) => prev.map((it) => (it.kind === "working" ? { ...it, text: "🎨 Painting" } : it)));
    });
    window.bean.onReviewBeforeClose(() => {
      if (hasActiveDelegates(itemsRef.current, pendingDelegateStartsRef.current.size) || liveRef.current) {
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
    const turnId = newId();
    setItems((prev) => [...prev, {
      kind: "user", id: turnId, text: message, display, source,
      images: images?.map((i) => `data:${i.mimeType};base64,${i.data}`),
    }, { kind: "working", id: workingId, text: "Spinning up" }]);

    // Image bytes ride only on the current turn; older turns keep a text placeholder
    // (mirrors chatops — see core's latestUserImages doc comment).
    const history = chatTurns(itemsRef.current);

    try {
      const res = await window.bean.chat({ history, message, source, incognito: incognitoRef.current, linkedNote: linkedNoteRef.current, images, turnId });
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
        if (res.proposedNote) {
          // Offer the images from the chat's latest turn that had any (chatops does the same).
          const withImages = [...next].reverse().find(
            (it): it is Extract<ChatItem, { kind: "user" }> => it.kind === "user" && (it.images?.length ?? 0) > 0,
          );
          next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending", images: withImages?.images });
        }
        if (res.proposedSkill) next.push({ kind: "skill", id: newId(), skill: res.proposedSkill, state: "pending" });
        if (res.proposedTodo) next.push({ kind: "todo", id: newId(), todo: res.proposedTodo, state: "pending" });
        if (res.proposedDelegate) next.push(...addDelegateProposal([], res.proposedDelegate, newId()));
        if (res.proposedLiveSession) next.push({ kind: "offer", id: newId(), offer: res.proposedLiveSession, state: "pending" });
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

  const addStatus = (text: string, tone: "info" | "done" | "error", details?: string[], id = newId()): void => {
    setItems((prev) => [...prev, { kind: "status", id, text, tone, ...(details?.length ? { details } : {}) }]);
  };
  const updateStatus = (id: string, text: string, tone: "info" | "done" | "error"): void => {
    setItems((prev) => prev.map((it) => (it.kind === "status" && it.id === id ? { ...it, text, tone } : it)));
  };

  // `/sprout`: one row per invocation, so parallel runs of the same sprout each update their own.
  // runNow resolves once the run is over (or refused up front).
  const runSprout = (name: string): void => {
    const rowId = newId();
    addStatus(`🌱 Running ${name}…`, "info", undefined, rowId);
    window.bean.routinesRunNow(name).then(
      (r) => r.started
        ? updateStatus(rowId, `🌱 ${name} — Run finished · see Dashboard`, "done")
        : updateStatus(rowId, `🌱 ${name} didn't run: ${r.reason ?? "refused"}`, "error"),
      (err: unknown) => updateStatus(rowId, `🌱 Couldn't run ${name}: ${err instanceof Error ? err.message : String(err)}`, "error"),
    );
  };

  // End the window's session (End, a switch, a project change, a close) and say where the chat goes
  // next. A session still starting is stopped once its id arrives (startSession). The row offers
  // Continue live, disabled until the child's `ended` event clears `exiting`.
  const endSession = (next?: string): void => {
    const l = liveRef.current;
    if (!l) return;
    setLive(undefined);
    if (l.sessionId) window.bean.liveStop(l.sessionId);
    const row: ChatItem = {
      kind: "status", id: newId(), tone: "info",
      text: `${AGENT_NAMES[l.agent]} ended (${l.turns} turn${l.turns === 1 ? "" : "s"})${next ? ` → ${next}` : ""}`,
      ...(l.receipt ? { receipt: l.receipt, ...(l.sessionId ? { exiting: l.sessionId } : {}) } : {}),
    };
    itemsRef.current = [...itemsRef.current, row]; // a close reads the transcript before the next render
    setItems((prev) => [...prev, row]);
  };

  const switchMode = (next: AgentId): void => {
    if (next === modeRef.current) return;
    endSession(AGENT_NAMES[next]);
    setMode(next);
  };

  const pickProject = (path: string): void => {
    if (path === agentProjectRef.current) return;
    rememberProject(path);
    // A session is bound to its project: changing it means end + a fresh start on the next send.
    const l = liveRef.current;
    if (l) endSession(`${AGENT_NAMES[l.agent]} · ${projects.find((p) => p.path === path)?.name ?? "scratch"}`);
  };

  const deliver = async (sessionId: string, agent: LiveCli, text: string): Promise<void> => {
    // Undefined = sent; otherwise why not (TURN_QUEUE_FULL, an ended session) — shown inline.
    const err = await window.bean.liveSend(sessionId, text).catch(() => "Couldn't reach the agent session.");
    if (err) { addStatus(err, "error"); return; }
    setItems((prev) => ensureStreaming(prev, sessionId, agent, newId()));
    const l = liveRef.current;
    if (l?.sessionId === sessionId) setLive({ ...l, busy: true });
  };

  // The opening turn: the transcript so far is handed over (main quotes the tail), then the text.
  const startSession = async (agent: LiveCli, text: string): Promise<void> => {
    const l: LiveState = { key: newId(), agent, projectPath: agentProjectRef.current, turns: 0, busy: true, queued: [] };
    setLive(l);
    const history = handoffItems(itemsRef.current);
    const userId = newId();
    setItems((prev) => [...prev, { kind: "user", id: userId, text, source: "live" }]);
    const res: LiveStartResult = await window.bean.liveStart({ agent, projectPath: l.projectPath, ask: text, history })
      .catch(() => ({ error: `${AGENT_NAMES[agent]} couldn't start.` }));
    if ("error" in res) {
      // A crash during startup already reported itself through the ended event.
      if (liveRef.current?.key === l.key) { setLive(undefined); addStatus(res.error, "error"); }
      return;
    }
    knownSessionsRef.current.add(res.sessionId);
    const cur = liveRef.current;
    if (cur?.key !== l.key) { window.bean.liveStop(res.sessionId); return; } // ended while starting
    setLive({ ...cur, sessionId: res.sessionId, queued: [] });
    if (res.handedOver > 0) {
      const row: ChatItem = {
        kind: "status", id: newId(), tone: "info",
        text: `Handed over ${res.handedOver} message${res.handedOver === 1 ? "" : "s"}`,
        details: handoffLines(history, res.handedOver),
      };
      setItems((prev) => {
        const at = prev.findIndex((it) => it.id === userId);
        return at < 0 ? [...prev, row] : [...prev.slice(0, at + 1), row, ...prev.slice(at + 1)];
      });
    }
    for (const q of cur.queued) await deliver(res.sessionId, agent, q);
  };

  // Typed composer text in agent mode. Only this path reaches an agent — loopbacks, skill prompts
  // and Save to notes call sendMessage directly, so they always stay Bean turns.
  const sendToAgent = (agent: LiveCli, text: string): void => {
    const l = liveRef.current;
    if (!l || l.agent !== agent) { void startSession(agent, text); return; }
    setItems((prev) => [...prev, { kind: "user", id: newId(), text, source: "live" }]);
    if (l.sessionId) void deliver(l.sessionId, agent, text);
    else l.queued.push(text);
  };

  // Commands parse here only — replies, streamed agent text, loopbacks and skill prompts never
  // pass through this path.
  const onComposerSend = (raw: string, images?: ImageAttachment[]): void => {
    let text = raw;
    const slash = resolveSlash(raw, modeRef.current, { agents: clis.filter(isLiveAgent), skills, sprouts });
    if (slash?.kind === "ambiguous" || slash?.kind === "unknown") {
      const where = slash.of === "skill" ? "Skills" : "Sprouts";
      addStatus(slash.kind === "unknown"
        ? `No ${slash.of} "${slash.slug}" — check the / menu.`
        : `/${slash.slug} matches more than one ${slash.of}: ${slash.names.map((n) => `"${n}"`).join(", ")} — rename one in ${where}.`, "error");
      return;
    }
    if (slash?.kind === "skill") {
      const skill = skills.find((s) => s.name === slash.name)!;
      if (skill.target !== "chat") {
        if (images?.length) { addStatus(`"${skill.name}" runs as a background agent — it takes text only.`, "error"); return; }
        runTerminalSkill(skill, slash.rest);
        return;
      }
      void sendMessage(composePrompt(skill, slash.rest), `▶ ${skill.name}${slash.rest ? ` — ${slash.rest}` : ""}`, false, images, "skill");
      return;
    }
    if (slash?.kind === "sprout") {
      if (slash.rest || images?.length) { addStatus(`"${slash.name}" is a sprout — it takes no text. Send the command on its own.`, "error"); return; }
      runSprout(slash.name);
      return;
    }
    if (slash?.kind === "agent") {
      const agent = slash.name as AgentId;
      if (agent !== "bean" && !clis.includes(agent)) {
        addStatus(`${AGENT_NAMES[agent]} isn't installed or is turned off in Settings.`, "error");
        return;
      }
      switchMode(agent);
      if (!slash.rest) return;
      text = slash.rest;
    }
    const agent = modeRef.current;
    if (isLiveAgent(agent)) sendToAgent(agent, text);
    else void sendMessage(text, undefined, false, images);
  };

  // Start on Bean's hand-off offer: the same handoff as `/claude <ask>` (startSession), with the
  // model's instruction as the ask line. Claimed once — a double click can't start two sessions.
  const startOffer = (id: string): void => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "offer" }> => it.kind === "offer" && it.id === id);
    const agent = offerAgent(clis);
    if (!item || item.state !== "pending" || !agent || offersClaimedRef.current.has(id)) return;
    offersClaimedRef.current.add(id);
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "offer" ? { ...it, state: "started" as const } : it)));
    endSession(AGENT_NAMES[agent]); // an older offer's Start replaces whatever session is running
    setMode(agent);
    // Scratch is "" in the window's project state (main maps it back); core sends its real path.
    rememberProject(projects.some((p) => p.path === item.offer.projectPath) ? item.offer.projectPath : "");
    void startSession(agent, item.offer.instruction);
  };

  // Continue live on a finished delegate card or an ended live session's row: only the receipt's
  // session id goes to main, which reads the CLI and project from the recorded run. No handoff — the
  // agent has its context. The button is hidden while a session is live, and liveRef is set before
  // the await, so a double click starts one session.
  const hasLive = (): boolean => liveRef.current !== undefined; // a function, so TS keeps liveRef unnarrowed
  const continueLive = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it) => it.id === id);
    const receipt = item?.kind === "delegate" ? item.receipt : item?.kind === "status" && !item.exiting ? item.receipt : undefined;
    const sessionId = receipt?.sessionId;
    const agent = receipt?.agent;
    if (!sessionId || !agent || hasLive()) return;
    // A placeholder until main answers with the recorded project.
    const projectPath = item?.kind === "delegate" ? item.proposal.projectPath : agentProjectRef.current;
    const l: LiveState = { key: newId(), agent, projectPath, turns: 0, busy: true, queued: [], continuing: true };
    const prevMode = modeRef.current;
    setLive(l);
    setMode(agent);
    const res = await window.bean.liveResume(sessionId).catch(() => ({ error: `${AGENT_NAMES[agent]} couldn't start.` }));
    if ("error" in res) {
      if (liveRef.current?.key === l.key) { setLive(undefined); setMode(prevMode); addStatus(res.error, "error"); }
      return;
    }
    knownSessionsRef.current.add(res.sessionId);
    const cur = liveRef.current;
    if (cur?.key !== l.key) { window.bean.liveStop(res.sessionId); return; } // ended while starting
    setLive({ ...cur, sessionId: res.sessionId, projectPath: res.projectPath, queued: [] });
    if (projects.some((p) => p.path === res.projectPath)) rememberProject(res.projectPath);
    for (const q of cur.queued) await deliver(res.sessionId, agent, q);
  };

  const dismissOffer = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "offer" && it.state === "pending" ? { ...it, state: "dismissed" as const } : it)));
  };

  const onLiveEvent = (e: LiveEvent): void => {
    const l = liveRef.current;
    if (e.type === "started" && l && !l.sessionId && l.agent === e.agent) {
      knownSessionsRef.current.add(e.sessionId);
      setLive({ ...l, sessionId: e.sessionId });
    }
    if (!knownSessionsRef.current.has(e.sessionId)) return;
    setItems((prev) => applyLiveEvent(prev, e, newId));
    // Rows and mode changes only for the current session; a late event from an ended one just
    // closes its bubbles.
    const cur = liveRef.current;
    if (!cur || cur.sessionId !== e.sessionId) return;
    if (e.type === "turn") setLive({ ...cur, turns: cur.turns + 1, busy: false });
    if (e.type === "session") setLive({ ...cur, receipt: e.receipt });
    if (e.type !== "ended") return;
    setLive(undefined);
    setMode("bean");
    const name = AGENT_NAMES[e.agent];
    // The child has exited: the receipt's Continue live is ready at once.
    const receipt = cur.receipt ? { receipt: cur.receipt } : {};
    const row = (text: string, tone: "info" | "error"): void => setItems((prev) => [...prev, { kind: "status", id: newId(), text, tone, ...receipt }]);
    if (e.reason === "failed") row(`${name} stopped unexpectedly: ${e.error ?? "no details"}. Back to Bean.`, "error");
    else if (e.reason === "ended") row(`${name} session ended (idle for 30 min, or it exited). /${e.agent} starts a fresh one with this chat.`, "info");
  };
  liveEventRef.current = onLiveEvent;

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
    if (!inChat) rememberProject(choice.projectPath ?? "");
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

  const startDelegate = async (id: string, projectPath: string, prompt: string, instruction: string, model?: string, skillName?: string): Promise<void> => {
    if (pendingDelegateStartsRef.current.has(id)) return;
    const start = window.bean.delegateStart({ projectPath, prompt, instruction, model, skillName });
    rememberProject(projectPath);
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
    return startDelegate(id, item.proposal.projectPath, editedPrompt, item.proposal.instruction, model, item.proposal.skillName);
  };

  // `/` terminal skill: Enter is the confirm, so it starts a tracked delegate at once, at the
  // destination its menu caption named. Everything is captured before the first await, and the
  // card id is fresh per send — a second Enter can't restart this run (startDelegate claims by id).
  // Browser access is main's call from skillName alone (delegate-tasks.ts), never this text.
  const runTerminalSkill = (skill: Skill, rest: string): void => {
    const dest = terminalDestination(skill.name, { projects, clis, models: runModels, delegateCli, lastUsedModels });
    const id = newId();
    const prompt = composePrompt(skill, rest);
    const instruction = `${skill.name}${rest ? ` — ${rest}` : ""}`;
    const proposal = { projectPath: dest.projectPath, instruction, skillName: skill.name, composedPrompt: prompt };
    setItems((prev) => addDelegateProposal(prev, proposal, id));
    // startDelegate attaches the task id to itemsRef after its await — mirror the card in now, or a
    // start that resolves before the next render would attach to (and overwrite) a list without it.
    itemsRef.current = addDelegateProposal(itemsRef.current, proposal, id);
    void startDelegate(id, dest.projectPath, prompt, instruction, dest.model, skill.name);
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

  const saveNote = async (id: string, edited: ProposedNote, asNew: boolean, images?: string[]): Promise<void> => {
    try {
      const attachments = (images ?? []).map(dataUrlToAttachment).filter((a): a is ImageAttachment => a !== undefined);
      const slug = await window.bean.saveNote({
        title: edited.title,
        body: edited.body,
        project: edited.project,
        slug: asNew ? undefined : edited.slug,
        source: "chat",
      }, attachments.length > 0 ? attachments : undefined);
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
      let text = `Couldn't save the note: ${err instanceof Error ? err.message : String(err)}`;
      // A linked update fails once its note is archived or deleted elsewhere: unlink and point
      // at the way out. Any other failure (transient) keeps the link so a retry still updates.
      if (!asNew && edited.slug !== undefined) {
        const notes = await window.bean.listNotes({ includeArchived: true }).catch(() => undefined);
        const now = notes?.find((n) => n.slug === edited.slug);
        if (notes && (!now || now.archivedAt)) {
          const name = now?.title ?? edited.title;
          text = now ? `"${name}" is archived — restore it in Notes, or use Save as new note.` : `"${name}" was deleted — use Save as new note.`;
          if (linkedNoteRef.current?.slug === edited.slug) {
            linkedNoteRef.current = undefined;
            setLinkedNote(undefined);
          }
        }
      }
      setItems((prev) => [...prev, { kind: "status", id: newId(), text, tone: "error" }]);
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

  const undoMemory = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "memory" }> => it.kind === "memory" && it.id === id);
    if (!item || item.state !== "saved") return;
    const setState = (state: "saved" | "undoing" | "undone"): void =>
      setItems((prev) => prev.map((it) => (it.id === id && it.kind === "memory" ? { ...it, state } : it)));
    setState("undoing");
    try {
      await window.bean.deleteMemories(item.saved.map((m) => m.id));
      rejectedMemoriesRef.current.push(...item.saved.map((m) => m.text));
      setState("undone");
    } catch (err) {
      setState("saved");
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
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
    if (transcript.length > 0) {
      window.bean.rememberOnClose(transcript, { incognito: incognitoRef.current, rejected: rejectedMemoriesRef.current });
    }
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
    // The session dies with the window anyway (main's stopOwner); stopping now is just sooner, and
    // leaves its Continue live row in the transcript.
    endSession();
    closeNow();
  };

  const delegatesRunning = closeFlow ? hasActiveDelegates(items, pendingDelegateStartsRef.current.size) : false;
  const liveName = live ? AGENT_NAMES[live.agent] : undefined;
  const closeTitle = liveName && delegatesRunning
    ? `A delegated task and a ${liveName} session are still running — closing stops both.`
    : liveName ? `${liveName} is still running — closing ends the session.`
      : "A delegated task is still running — closing will stop it.";

  return (
    <div class="bean-dashboard bean-chat-window">
      {closeFlow?.stage === "delegates" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">{closeTitle}</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={keepWorking}>Keep working</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={stopDelegatesAndClose}>
                {liveName && !delegatesRunning ? `End ${liveName} session & close` : "Stop & close"}
              </button>
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
        sprouts={sprouts}
        delegateCli={delegateCli}
        onSlashOpen={refreshCatalogs}
        onSend={onComposerSend}
        mode={mode}
        agentProject={agentProject}
        live={live ? { agent: live.agent, projectPath: live.projectPath, busy: live.busy, continuing: live.continuing } : undefined}
        onPickAgent={switchMode}
        onPickProject={pickProject}
        onEndAgent={() => { endSession("Bean"); setMode("bean"); }}
        onConfirm={confirmProposal}
        onCancel={cancelProposal}
        onNoteSave={(id, edited, asNew, images) => void saveNote(id, edited, asNew, images)}
        onNoteDismiss={dismissNote}
        onSkillSave={(id, edited) => void saveSkill(id, edited)}
        onSkillDismiss={dismissSkill}
        onTodoQueue={(id) => void queueTodo(id)}
        onTodoDismiss={dismissTodo}
        onOfferStart={startOffer}
        onOfferDismiss={dismissOffer}
        onDelegateConfirm={(id, edited, model) => void confirmDelegate(id, edited, model)}
        onDelegateDismiss={dismissDelegate}
        onDelegateCancelTask={cancelDelegateTask}
        onContinueLive={(id) => void continueLive(id)}
        onSaveToNotes={saveToNotes}
        onUnlink={() => setLinkedNote(undefined)}
        incognito={incognito}
        onToggleIncognito={toggleIncognito}
        onMemoryUndo={(id) => void undoMemory(id)}
      />
    </div>
  );
}
