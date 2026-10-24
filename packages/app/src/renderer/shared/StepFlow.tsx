import { useId } from "preact/hooks";
import type { FlowEdge, RoutineStep } from "@bean/core";
import { stepFlow } from "@bean/core/routine-graph";
import { layoutStepFlow, NODE_H, NODE_W } from "./step-flow-layout.js";

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const edgeLabel = (e: FlowEdge): string | undefined =>
  e.kind === "path" ? e.label : e.kind === "otherwise" ? "otherwise" : e.kind === "fail" ? "fail"
    : e.kind === "loop" ? `fail · ≤${e.maxRounds}×` : undefined;

// The screen-reader summary: numbers and fixed words only, never step or label text.
const VERB: Record<FlowEdge["kind"], string> = {
  flow: "then", next: "then", pass: "on pass", fail: "on fail", loop: "on fail loops back to", path: "may go to", otherwise: "otherwise",
};
const summary = (edges: FlowEdge[]): string =>
  `Step flow: ${edges.map((e) => `${e.from + 1} ${VERB[e.kind]} ${typeof e.to === "number" ? `step ${e.to + 1}` : e.to}`).join("; ")}`;

/** A read-only picture of the sprout's whole shape (gates, loops, routes, rejoins, ends) as
 * inline SVG. All user text is JSX text — no markup, URLs, or user-controlled attributes. */
export function StepFlow(props: { steps: RoutineStep[] }) {
  const markerId = useId();
  const flow = stepFlow(props.steps);
  const layout = layoutStepFlow(flow);
  const marker = (accent: boolean): string => `url(#${markerId}-${accent ? "a" : "l"})`;
  return (
    <div class="bean-flow">
      <svg class="bean-flow-svg" width={layout.width} height={layout.height} viewBox={layout.viewBox} role="img" aria-label={summary(flow.edges)}>
        <defs>
          {[false, true].map((accent) => (
            <marker key={String(accent)} id={`${markerId}-${accent ? "a" : "l"}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" class={accent ? "bean-flow-accent" : "bean-flow-line"} />
            </marker>
          ))}
        </defs>
        {layout.edges.map(({ edge, d, x, y, cap }, k) => {
          const accent = edge.kind === "fail" || edge.kind === "loop";
          const label = edgeLabel(edge);
          return (
            <g key={k}>
              <path
                d={d}
                class={`bean-flow-edge ${accent ? "bean-flow-accent" : "bean-flow-line"}${edge.kind === "loop" ? " bean-flow-edge--loop" : ""}`}
                marker-end={cap ? undefined : marker(accent)}
              />
              {label ? (
                <text class="bean-flow-label" x={x} y={y} text-anchor={edge.kind === "loop" ? "start" : "middle"}>
                  <title>{label}</title>{clip(label, 12)}
                </text>
              ) : null}
              {cap ? <text class={`bean-flow-cap${edge.to === "stop" ? " bean-flow-cap--stop" : ""}`} x={cap.x} y={cap.y} text-anchor="middle">{edge.to === "stop" ? "■ stop" : "● end"}</text> : null}
            </g>
          );
        })}
        {layout.boxes.map((b) => {
          const step = props.steps[b.index]!;
          const node = flow.nodes[b.index]!;
          const text = step.kind === "command" ? step.command : step.instruction;
          return (
            <g key={node.key}>
              <rect class={`bean-flow-node${node.flagged ? " bean-flow-node--flagged" : ""}`} x={b.x} y={b.y} width={NODE_W} height={NODE_H} rx="9" />
              <text class="bean-flow-title" x={b.x + 10} y={b.y + 18}>{clip(`${b.index + 1} · ${step.skill || step.kind}`, 22)}</text>
              <text class="bean-flow-snippet" x={b.x + 10} y={b.y + 34}>{clip(text ?? "", 30)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
