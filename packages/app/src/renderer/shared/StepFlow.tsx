import { useId } from "preact/hooks";
import type { FlowEdge, RoutineStep } from "@bean/core";
import { stepFlow } from "@bean/core/routine-graph";
import { layoutStepFlow, NODE_H, NODE_W } from "./step-flow-layout.js";

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// A fork bundle keeps the label of the edge it replaced (a route path into a group), once.
const edgeLabel = (e: FlowEdge): string | undefined => {
  const kind = e.kind === "fork" ? e.via : e.kind;
  return kind === "path" ? e.label : kind === "otherwise" ? "otherwise" : kind === "fail" ? "fail"
    : e.kind === "loop" ? `fail · ≤${e.maxRounds}×` : undefined;
};

// The screen-reader summary: numbers and fixed words only, never step or label text.
const VERB: Record<FlowEdge["kind"], string> = {
  flow: "then", next: "then", pass: "on pass", fail: "on fail", loop: "on fail loops back to", path: "may go to", otherwise: "otherwise",
  fork: "starts", join: "joins at",
};
const summary = (edges: FlowEdge[], shared: number[][], overlay?: FlowOverlay): string =>
  `Step flow: ${edges.map((e) => `${e.from + 1} ${VERB[e.kind]} ${typeof e.to === "number" ? `step ${e.to + 1}` : e.to}`).join("; ")}` +
  (shared.length ? `. Shared sessions: ${shared.map((l) => `steps ${l.map((k) => k + 1).join(", ")}`).join("; ")}` : "") +
  (overlay ? `. This run: ${overlay.counts.map((c, i) => `step ${i + 1} ${c === 0 ? "not reached" : `ran${c > 1 ? ` ${c} times` : ""}${overlay.failed[i] ? ", failed" : ""}`}`).join("; ")}` : "");

/** A run's path over the diagram (see runFlowOverlay): executions per node (0 = dimmed), failed
 * nodes, and the indexes into `stepFlow(steps).edges` it took. */
export interface FlowOverlay { counts: number[]; failed: boolean[]; edges: Set<number> }

/** Steps per session lane (see stepLanes), lanes of one step left out — those share nothing. */
const sharedLanes = (lanes: number[]): number[][] => {
  const by = new Map<number, number[]>();
  lanes.forEach((root, k) => by.set(root, [...(by.get(root) ?? []), k]));
  return [...by.values()].filter((l) => l.length > 1);
};

/** A read-only picture of the sprout's whole shape (gates, loops, routes, rejoins, parallel groups, ends) as
 * inline SVG. All user text is JSX text — no markup, URLs, or user-controlled attributes. With an
 * `overlay` the accent marks the path a run took instead of the fail edges. With `lanes` (stepLanes)
 * a step that shares an agent session gets a `↻N` badge, N its lane's first step. */
export function StepFlow(props: { steps: RoutineStep[]; overlay?: FlowOverlay; lanes?: number[] }) {
  const { overlay } = props;
  const shared = sharedLanes(props.lanes ?? []);
  const laneOf = new Map(shared.flatMap((l) => l.map((k) => [k, l[0]!] as const)));
  const markerId = useId();
  const flow = stepFlow(props.steps);
  const layout = layoutStepFlow(flow);
  const marker = (accent: boolean): string => `url(#${markerId}-${accent ? "a" : "l"})`;
  return (
    <div class="bean-flow" tabindex={0}>
      <svg class="bean-flow-svg" width={layout.width} height={layout.height} viewBox={layout.viewBox} role="img" aria-label={summary(flow.edges, shared, overlay)}>
        <defs>
          {[false, true].map((accent) => (
            <marker key={String(accent)} id={`${markerId}-${accent ? "a" : "l"}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" class={accent ? "bean-flow-accent" : "bean-flow-line"} />
            </marker>
          ))}
        </defs>
        {layout.edges.map(({ edge, d, x, y, cap, repeat }, k) => {
          if (repeat) return null;
          // Overlay edges index `flow.edges`; the layout orders them differently.
          const lit = overlay?.edges.has(flow.edges.indexOf(edge));
          const accent = overlay ? Boolean(lit) : edge.kind === "fail" || edge.kind === "loop" || edge.via === "fail";
          const label = edgeLabel(edge);
          return (
            <g key={k}>
              <path
                d={d}
                class={`bean-flow-edge ${accent ? "bean-flow-accent" : "bean-flow-line"}${edge.kind === "loop" ? " bean-flow-edge--loop" : ""}${lit ? " bean-flow-edge--lit" : ""}`}
                marker-end={cap || typeof edge.to !== "number" ? undefined : marker(accent)}
              />
              {label ? (
                <text class="bean-flow-label" x={x} y={y} text-anchor={edge.kind === "loop" ? "start" : "middle"}>
                  <title>{label}</title>{clip(label, 12)}
                </text>
              ) : null}
              {cap ? <text class={`bean-flow-cap${overlay && !lit ? " bean-flow-cap--dim" : edge.to === "stop" ? " bean-flow-cap--stop" : ""}`} x={cap.x} y={cap.y} text-anchor="middle">{edge.to === "stop" ? "■ stop" : "● end"}</text> : null}
            </g>
          );
        })}
        {layout.groups.map((g) => (
          <g key={g.first}>
            <rect class={`bean-flow-group ${overlay?.counts.slice(g.first, g.first + g.n).some((c) => c > 0) ? "bean-flow-accent" : "bean-flow-line"}`} x={g.x} y={g.y} width={g.w} height={g.h} rx="14" />
            <text class="bean-flow-label bean-flow-group-label" x={g.x + 10} y={g.y + 3.5}>{`⫴ together · ${g.n}`}</text>
          </g>
        ))}
        {layout.boxes.map((b) => {
          const step = props.steps[b.index]!;
          const node = flow.nodes[b.index]!;
          const text = step.kind === "command" ? step.command : step.instruction;
          const count = overlay?.counts[b.index] ?? 0;
          const mark = `${count > 1 ? ` ×${count}` : ""}${overlay?.failed[b.index] ? " ✗" : ""}`;
          const lane = laneOf.get(b.index);
          return (
            <g key={node.key} class={overlay && count === 0 ? "bean-flow-dim" : undefined}>
              <rect class={`bean-flow-node${node.flagged ? " bean-flow-node--flagged" : ""}${overlay && count > 0 ? " bean-flow-node--ran" : ""}`} x={b.x} y={b.y} width={NODE_W} height={NODE_H} rx="9" />
              {/* HTML, not <text>: CSS ellipsis clips by real glyph width, a char count can't. */}
              <foreignObject x={b.x + 10} y={b.y + 5} width={NODE_W - 20} height={NODE_H - 10}>
                <div class="bean-flow-title"><span class="bean-flow-clip">{`${b.index + 1} · ${step.skill || step.kind}`}</span>{lane === undefined ? null : <span class="bean-flow-lane" title={`Shares step ${lane + 1}'s agent session`}>{` ↻${lane + 1}`}</span>}{mark}</div>
                <div class="bean-flow-snippet bean-flow-clip">{(text ?? "").replace(/\s+/g, " ").trim()}</div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
