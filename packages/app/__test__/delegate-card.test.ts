import { beforeEach, expect, test, vi } from "vitest";

const hookState = vi.hoisted(() => ({ explicitModel: undefined as string | undefined }));

vi.mock("preact/hooks", () => ({
  useEffect: () => {},
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [
    initial === undefined ? hookState.explicitModel : initial,
    () => {},
  ] as const,
}));

import { DelegateCard } from "../src/renderer/components/chat/DelegateCard.js";

interface TestVNode {
  type?: unknown;
  props?: { children?: unknown; class?: string; onClick?: () => void };
}

function nodes(value: unknown): TestVNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== "object" || value === null) return [];
  const node = value as TestVNode;
  return [node, ...nodes(node.props?.children)];
}

function clickConfirm(onConfirm: (prompt: string, choice: { projectPath: string; model?: string }) => void, lastUsedModel?: string): void {
  const card = DelegateCard({
    item: {
      kind: "delegate",
      id: "delegate-1",
      proposal: { projectPath: "/p", instruction: "do it", composedPrompt: "prompt" },
      state: "pending",
      tail: [],
    },
    onConfirm,
    lastUsedModel,
    onDismiss: () => {},
    onCancelTask: () => {},
    cliOptions: ["claude", "codex"],
    modelOptions: [
      { id: "sonnet", label: "sonnet", availableOn: ["claude"] },
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol", availableOn: ["codex"] },
    ],
  });
  const confirm = nodes(card).find((node) => node.type === "button" && node.props?.class === "bean-btn");
  expect(confirm?.props?.onClick).toBeTypeOf("function");
  confirm?.props?.onClick?.();
}

beforeEach(() => { hookState.explicitModel = undefined; });

test("an untouched delegate card does not send its display-default model as an explicit choice", () => {
  const onConfirm = vi.fn();
  clickConfirm(onConfirm);
  expect(onConfirm).toHaveBeenCalledWith("prompt", { projectPath: "/p" });
});

test("a model the user explicitly selected is sent with the delegate request", () => {
  hookState.explicitModel = "gpt-5.6-sol";
  const onConfirm = vi.fn();
  clickConfirm(onConfirm);
  expect(onConfirm).toHaveBeenCalledWith("prompt", { projectPath: "/p", model: "gpt-5.6-sol" });
});

test("a pending card starts on the skill's remembered model and sends it", () => {
  const onConfirm = vi.fn();
  clickConfirm(onConfirm, "sonnet");
  expect(onConfirm).toHaveBeenCalledWith("prompt", { projectPath: "/p", model: "sonnet" });
});

test("a remembered model no enabled CLI supports is dropped, not sent", () => {
  const onConfirm = vi.fn();
  clickConfirm(onConfirm, "retired-model");
  expect(onConfirm).toHaveBeenCalledWith("prompt", { projectPath: "/p" });
});
