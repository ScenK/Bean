import { beforeEach, expect, test, vi } from "vitest";

const hookState = vi.hoisted(() => ({ explicitModel: undefined as string | undefined }));

vi.mock("preact/hooks", () => ({
  useEffect: () => {},
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

function clickConfirm(onConfirm: (prompt: string, model?: string) => void): void {
  const card = DelegateCard({
    item: {
      kind: "delegate",
      id: "delegate-1",
      proposal: { projectPath: "/p", instruction: "do it", composedPrompt: "prompt" },
      state: "pending",
      tail: [],
    },
    onConfirm,
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
  expect(onConfirm).toHaveBeenCalledWith("prompt", undefined);
});

test("a model the user explicitly selected is sent with the delegate request", () => {
  hookState.explicitModel = "gpt-5.6-sol";
  const onConfirm = vi.fn();
  clickConfirm(onConfirm);
  expect(onConfirm).toHaveBeenCalledWith("prompt", "gpt-5.6-sol");
});
