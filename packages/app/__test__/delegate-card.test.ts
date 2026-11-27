import { beforeEach, expect, test, vi } from "vitest";
import type { CliName } from "@bean/core";

// useState calls with an undefined initial are, in order, the card's model, effort, and CLI picks.
const hookState = vi.hoisted(() => ({
  model: undefined as string | undefined,
  effort: undefined as string | undefined,
  cli: undefined as string | undefined,
  n: 0,
}));

vi.mock("preact/hooks", () => ({
  useEffect: () => {},
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [
    initial === undefined
      ? ([hookState.model, hookState.effort, hookState.cli][hookState.n++ % 3])
      : initial,
    () => {},
  ] as const,
}));

import { DelegateCard } from "../src/renderer/components/chat/DelegateCard.js";

interface TestVNode {
  type?: unknown;
  props?: { children?: unknown; class?: string; disabled?: boolean; onClick?: () => void };
}

function nodes(value: unknown): TestVNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== "object" || value === null) return [];
  const node = value as TestVNode;
  return [node, ...nodes(node.props?.children)];
}

type Choice = { projectPath: string; model?: string; effort?: string; cli?: CliName };
const MODELS: Array<{ id: string; label: string; availableOn: CliName[]; effortsByCli?: Partial<Record<CliName, { efforts: string[]; defaultEffort?: string }>> }> = [
  { id: "sonnet", label: "sonnet", availableOn: ["claude" as const] },
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol", availableOn: ["codex" as const] },
  { id: "shared", label: "shared", availableOn: ["claude" as const, "opencode" as const] },
];

function confirmed(opts: { lastUsedModel?: string; lastUsedEffort?: string; delegateCli?: string; clis?: CliName[]; models?: typeof MODELS } = {}): Choice | undefined {
  hookState.n = 0;
  const onConfirm = vi.fn();
  const card = DelegateCard({
    item: {
      kind: "delegate",
      id: "delegate-1",
      proposal: { projectPath: "/p", instruction: "do it", composedPrompt: "prompt" },
      state: "pending",
      tail: [],
    },
    onConfirm,
    lastUsedModel: opts.lastUsedModel,
    lastUsedEffort: opts.lastUsedEffort,
    delegateCli: opts.delegateCli ?? "",
    onDismiss: () => {},
    onCancelTask: () => {},
    cliOptions: opts.clis ?? ["claude", "codex", "opencode"],
    modelOptions: opts.models ?? MODELS,
  });
  const confirm = nodes(card).find((node) => node.type === "button" && node.props?.class === "bean-btn");
  if (confirm?.props?.disabled) return undefined;
  confirm?.props?.onClick?.();
  return onConfirm.mock.calls[0]?.[1] as Choice | undefined;
}

beforeEach(() => { hookState.model = undefined; hookState.effort = undefined; hookState.cli = undefined; });

test("an untouched card sends the pair it shows: the Settings CLI and its first model", () => {
  expect(confirmed({ delegateCli: "codex" })).toEqual({ projectPath: "/p", cli: "codex", model: "gpt-5.6-sol" });
  expect(confirmed()).toEqual({ projectPath: "/p", cli: "claude", model: "sonnet" }); // auto = first enabled
});

test("the remembered model picks the default CLI, as main's resolveDelegateSelection does", () => {
  expect(confirmed({ delegateCli: "codex", lastUsedModel: "sonnet" })).toEqual({ projectPath: "/p", cli: "claude", model: "sonnet" });
});

test("picking codex over a claude-only remembered model runs codex with codex's model", () => {
  hookState.cli = "codex";
  expect(confirmed({ lastUsedModel: "sonnet" })).toEqual({ projectPath: "/p", cli: "codex", model: "gpt-5.6-sol" });
  hookState.model = "sonnet"; // a stale explicit pick is dropped too
  expect(confirmed({ lastUsedModel: "sonnet" })).toEqual({ projectPath: "/p", cli: "codex", model: "gpt-5.6-sol" });
});

test("with a shared model id, picking opencode sends opencode", () => {
  hookState.cli = "opencode";
  hookState.model = "shared";
  expect(confirmed()).toEqual({ projectPath: "/p", cli: "opencode", model: "shared" });
});

test("a CLI with no listed models stays selectable and sends no model", () => {
  hookState.cli = "opencode";
  const models = MODELS.slice(0, 2); // opencode lists none
  expect(confirmed({ models, lastUsedModel: "sonnet" })).toEqual({ projectPath: "/p", cli: "opencode" });
  hookState.cli = undefined;
  expect(confirmed({ models, clis: ["opencode"] })).toEqual({ projectPath: "/p", cli: "opencode" });
});

test("a remembered model no enabled CLI supports is dropped, not sent", () => {
  expect(confirmed({ lastUsedModel: "retired-model" })).toEqual({ projectPath: "/p", cli: "claude", model: "sonnet" });
});

test("no enabled CLI: Start is disabled", () => {
  expect(confirmed({ clis: [] })).toBeUndefined();
});

test("model with efforts sends its default, remembered, or explicitly picked effort", () => {
  const models = [
    { id: "opus", label: "opus", availableOn: ["claude" as const], effortsByCli: { claude: { efforts: ["low", "medium", "high", "max"], defaultEffort: "high" } } },
  ];
  expect(confirmed({ models, clis: ["claude"] })).toEqual({ projectPath: "/p", cli: "claude", model: "opus", effort: "high" });
  expect(confirmed({ models, clis: ["claude"], lastUsedEffort: "low" })).toEqual({ projectPath: "/p", cli: "claude", model: "opus", effort: "low" });
  hookState.effort = "max";
  expect(confirmed({ models, clis: ["claude"], lastUsedEffort: "low" })).toEqual({ projectPath: "/p", cli: "claude", model: "opus", effort: "max" });
});

const text = (value: unknown): string => nodes(value).map((n) => (typeof n.props?.children === "string" ? n.props.children : Array.isArray(n.props?.children) ? n.props.children.filter((c) => typeof c === "string").join("") : "")).join("|");

test("a continued run is a compact card: what it continues, its instruction and Stop — nothing to confirm (#1113)", () => {
  hookState.n = 0;
  const onCancelTask = vi.fn();
  const card = DelegateCard({
    item: {
      kind: "delegate", id: "d2", continued: true, taskId: "t2", state: "running", tail: [],
      proposal: { projectPath: "/p", instruction: "add a test", composedPrompt: "add a test", cli: "claude" },
    },
    onConfirm: vi.fn(), onDismiss: vi.fn(), onCancelTask,
    projectOptions: [{ name: "Bean", path: "/p" }],
  });
  const all = text(card);
  expect(all).toContain("↻ continuing claude · Bean");
  expect(all).toContain("add a test");
  expect(nodes(card).some((n) => n.type === "textarea")).toBe(false);
  const stop = nodes(card).find((n) => n.type === "button" && n.props?.children === "Stop");
  stop?.props?.onClick?.();
  expect(onCancelTask).toHaveBeenCalledOnce();
});

test("Bean's own follow-up shows which of its budget it is (#1132)", () => {
  hookState.n = 0;
  const card = DelegateCard({
    item: {
      kind: "delegate", id: "d3", continued: true, taskId: "t3", state: "running", tail: [],
      proposal: { projectPath: "/p", instruction: "finish the ledger step", composedPrompt: "x", cli: "claude", followUp: 1 },
    },
    onConfirm: vi.fn(), onDismiss: vi.fn(), onCancelTask: vi.fn(),
    projectOptions: [{ name: "Bean", path: "/p" }],
  });
  expect(text(card)).toContain("↻ following up (1/2) claude · Bean");
  expect(text(card)).toContain("finish the ledger step");
  expect(nodes(card).some((n) => n.type === "button" && n.props?.children === "Stop")).toBe(true);
});

test("the grant line shows only while the card's grant is live (#1113)", () => {
  const item = {
    kind: "delegate" as const, id: "d1", taskId: "t1", state: "done" as const, tail: [], result: "ok",
    proposal: { projectPath: "/p", instruction: "fix", composedPrompt: "fix" },
  };
  const line = "Follow-ups of this task continue this session automatically while this chat is open.";
  hookState.n = 0;
  expect(text(DelegateCard({ item, onConfirm: vi.fn(), onDismiss: vi.fn(), onCancelTask: vi.fn(), granted: true }))).toContain(line);
  hookState.n = 0;
  expect(text(DelegateCard({ item, onConfirm: vi.fn(), onDismiss: vi.fn(), onCancelTask: vi.fn() }))).not.toContain(line);
});
