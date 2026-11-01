import { beforeEach, expect, test, vi } from "vitest";
import type { CliName } from "@bean/core";

// useState calls with an undefined initial are, in order, the card's model pick and CLI pick.
const hookState = vi.hoisted(() => ({ model: undefined as string | undefined, cli: undefined as string | undefined, n: 0 }));

vi.mock("preact/hooks", () => ({
  useEffect: () => {},
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [
    initial === undefined ? (hookState.n++ % 2 === 0 ? hookState.model : hookState.cli) : initial,
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

type Choice = { projectPath: string; model?: string; cli?: CliName };
const MODELS = [
  { id: "sonnet", label: "sonnet", availableOn: ["claude" as const] },
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol", availableOn: ["codex" as const] },
  { id: "shared", label: "shared", availableOn: ["claude" as const, "opencode" as const] },
];

function confirmed(opts: { lastUsedModel?: string; delegateCli?: string; clis?: CliName[]; models?: typeof MODELS } = {}): Choice | undefined {
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

beforeEach(() => { hookState.model = undefined; hookState.cli = undefined; });

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
