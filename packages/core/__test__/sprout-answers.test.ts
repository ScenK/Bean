import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTodo, answerOf, answerStepIndex, answerTodoText, claimAnswers, listTodos, queueTodoDispatch, releaseTodo,
  resolveTodoRoutine, runRoutine, getDispatch, updateTodoStatus, type Routine, type RoutineRunnerDeps, type TodoItem, type TodoStatus,
} from "../src/index.js";
import { closeDb } from "../src/db.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-answers-"));
  file = join(dir, "bean.db");
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const mail: Routine = {
  name: "mail", enabled: true, cron: "0 7 * * *",
  steps: [
    { kind: "command", command: "fetch-mail" },
    { kind: "delegate", project: "/p", instruction: "file the mail" },
    { kind: "chat", instruction: "summarize" },
  ],
  sinks: {},
};

/** Runner deps backed by the real todo store, so claims and statuses hit SQLite. */
function deps(over: Partial<RoutineRunnerDeps> = {}): { deps: RoutineRunnerDeps; prompts: string[]; commands: Record<string, string>[] } {
  const prompts: string[] = [];
  const commands: Record<string, string>[] = [];
  return {
    prompts, commands,
    deps: {
      chat: async ({ messages }) => { prompts.push(messages.map((m) => String(m.content)).join("\n")); return { content: "chat ok", toolCalls: [] }; },
      model: "m",
      delegate: async (req) => { prompts.push(req.instruction); return "delegate ok"; },
      command: async (req) => { commands.push(req.env ?? {}); return { exitCode: 0, output: "fetched" }; },
      tools: [], findSkill: () => undefined,
      todos: {
        claim: async () => undefined,
        setStatus: (id: string, status: TodoStatus, summary?: string) => updateTodoStatus(file, id, status, summary),
        claimAnswers: (r, limit) => claimAnswers(file, r, limit),
        release: (id, note) => releaseTodo(file, id, note),
      },
      ...over,
    },
  };
}

const byId = (items: TodoItem[], id: string): TodoItem | undefined => items.find((t) => t.id === id);

describe("sprout answers (#1135)", () => {
  it("answerStepIndex skips commands and retro; answer text keeps the answer whole", () => {
    expect(answerStepIndex(mail)).toBe(1);
    expect(answerStepIndex({ steps: [{ kind: "chat", skill: "retro", instruction: "r" }, { kind: "chat", instruction: "c" }] })).toBe(1);
    expect(answerStepIndex({ steps: [{ kind: "command", command: "a" }] })).toBe(-1);
    const text = answerTodoText("it's on autopay", `card bill due Dec 22\n${"x".repeat(3000)}`);
    expect(answerOf(text)).toBe("it's on autopay");
    expect(text).toContain("[…truncated]");
    expect(answerTodoText(" ok ", "")).toBe("ok");
  });

  it("resolveTodoRoutine takes an owner's answer on a plain sprout, refuses members and all-command sprouts", () => {
    const cmd: Routine = { ...mail, name: "cmd", steps: [{ kind: "command", command: "a" }] };
    expect(resolveTodoRoutine([mail], "mail", false, new Date(), true)).toBe(mail);
    expect(() => resolveTodoRoutine([mail], "mail")).toThrow("not todo-driven");
    expect(() => resolveTodoRoutine([mail], "mail", true, new Date(), true)).toThrow("only the owner can answer mail");
    expect(() => resolveTodoRoutine([cmd], "cmd", false, new Date(), true)).toThrow("no chat or delegate step");
  });

  it("claimAnswers is bounded and two claims never share an answer", async () => {
    for (const t of ["a", "b", "c"]) await addTodo(file, "mail", t);
    const [x, y] = await Promise.all([claimAnswers(file, "mail", 2), claimAnswers(file, "mail", 2)]);
    expect(x!.map((t) => t.text)).toEqual(["a", "b"]);
    expect(y!.map((t) => t.text)).toEqual(["c"]);
  });

  it("a plain run hands its answers to the first delegate step only — never the command — and closes them with a receipt", async () => {
    const q = queueTodoDispatch(file, { routine: "mail", text: answerTodoText("it's on autopay", "card bill due Dec 22?") }, { surface: "discord", conversation: "c1" });
    const d = deps();
    const result = await runRoutine(mail, d.deps);
    expect(result.record.status).toBe("ok");
    expect(d.commands).toEqual([{}]); // the command step gets no answer, not even as env
    expect(d.prompts[0]).toContain("Replies to your earlier reports");
    expect(d.prompts[0]).toContain("it's on autopay");
    expect(d.prompts[1]).not.toContain("it's on autopay"); // the later chat step doesn't
    expect(result.todoIds).toBeUndefined(); // sinks still get the run's report
    const row = byId(await listTodos(file, "mail"), q.todo.id)!;
    expect(row.status).toBe("done");
    const notice = getDispatch(file, q.jobId)!;
    expect(notice.status).toBe("ok");
    expect(notice.brief).toContain(`Your answer: "it's on autopay"`);
    expect(notice.brief).not.toContain("card bill"); // its own answer, not the quoted post
  });

  it("a run failing before the answer step hands answers back once, then fails them", async () => {
    const t = await addTodo(file, "mail", "it's on autopay");
    const failing = deps({ command: async () => ({ exitCode: 1, output: "boom" }) });
    // Gated so the command's failure stops the pass before the delegate.
    const gated: Routine = { ...mail, steps: [{ ...mail.steps[0]!, id: "fetch", next: "file" } as Routine["steps"][number], { ...mail.steps[1]!, id: "file" } as Routine["steps"][number]] };
    await runRoutine(gated, failing.deps);
    let row = byId(await listTodos(file, "mail"), t.id)!;
    expect(row.status).toBe("pending");
    await runRoutine(gated, failing.deps);
    row = byId(await listTodos(file, "mail"), t.id)!;
    expect(row.status).toBe("failed");
    expect(row.resultSummary).toContain("two runs ended before reaching");
    expect(failing.prompts.join("\n")).not.toContain("it's on autopay"); // only the run digest's model call
  });

  it("a stopped run fails its claimed answers like a stopped todo", async () => {
    const t = await addTodo(file, "mail", "answer");
    const ctl = new AbortController();
    const d = deps({ delegate: async () => { ctl.abort(); throw new Error("cancelled"); } });
    await runRoutine(mail, { ...d.deps, signal: ctl.signal });
    const row = byId(await listTodos(file, "mail"), t.id)!;
    expect(row.status).toBe("failed");
  });

  it("an all-command sprout claims no answers", async () => {
    const t = await addTodo(file, "cmd", "answer");
    const d = deps();
    await runRoutine({ ...mail, name: "cmd", steps: [{ kind: "command", command: "a" }] }, d.deps);
    expect(byId(await listTodos(file, "cmd"), t.id)!.status).toBe("pending");
  });
});
