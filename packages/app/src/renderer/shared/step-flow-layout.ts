import type { FlowEdge, FlowNode } from "@bean/core";

// Fixed sizes: no DOM measurement. Text is clipped to fit, not measured.
export const NODE_W = 170;
export const NODE_H = 44;
const COL_GAP = 36;
const ROW_GAP = 56;
const PAD = 12;
const LANE = 12;
const GUTTER = 72;
const STUB = 24;

export interface FlowBox { index: number; x: number; y: number; row: number; col: number }
/** `d` is an SVG path; `x`/`y` place the edge's label; `cap` places an end/stop terminal. */
export interface FlowLine { edge: FlowEdge; d: string; x: number; y: number; cap?: { x: number; y: number } }
export interface FlowLayout { boxes: FlowBox[]; edges: FlowLine[]; width: number; height: number; viewBox: string }

/** Lays the flow out top to bottom: row = longest forward path from step 1, column = order of
 * first arrival (route paths side by side, a rejoin below them all), each row centred. Gate loops
 * (the only backward edges) are dashed lanes in a left gutter. Pure and deterministic.
 * ponytail: no crossing minimization — a skip over a row draws through it; switch to dagre if
 * real sprouts tangle. */
export function layoutStepFlow(flow: { nodes: FlowNode[]; edges: FlowEdge[] }): FlowLayout {
  const n = flow.nodes.length;
  const row: (number | undefined)[] = flow.nodes.map(() => undefined);
  const arrival: number[] = flow.nodes.map(() => 0);
  let seq = 0;
  // Forward edges only point to later steps, so index order is a topological order: a step's
  // row is final by the time it's visited. A step nothing reaches starts a row below the last.
  for (let i = 0; i < n; i++) {
    if (row[i] === undefined) {
      row[i] = i === 0 ? 0 : Math.max(...row.slice(0, i).map((r) => r!)) + 1;
      arrival[i] = seq++;
    }
    for (const e of flow.edges) {
      if (e.from !== i || typeof e.to !== "number" || e.to <= i) continue;
      if (row[e.to] === undefined) arrival[e.to] = seq++;
      row[e.to] = Math.max(row[e.to] ?? 0, row[i]! + 1);
    }
  }
  const rows = n === 0 ? 0 : Math.max(...row.map((r) => r!)) + 1;
  const byRow = Array.from({ length: rows }, (_, r) =>
    flow.nodes.map((_, i) => i).filter((i) => row[i] === r).sort((a, b) => arrival[a]! - arrival[b]!));
  const cols = Math.max(1, ...byRow.map((r) => r.length));
  const loops = flow.edges.filter((e) => e.kind === "loop");
  const left = PAD + (loops.length ? GUTTER + loops.length * LANE : 0);
  const boxes: FlowBox[] = [];
  byRow.forEach((ids, r) => ids.forEach((index, col) => {
    const offset = ((cols - ids.length) * (NODE_W + COL_GAP)) / 2;
    boxes[index] = { index, row: r, col, x: left + offset + col * (NODE_W + COL_GAP), y: PAD + r * (NODE_H + ROW_GAP) };
  }));

  const edges: FlowLine[] = [];
  // Each step's downward edges (forward + end/stop caps) leave from evenly spread ports.
  const down = (i: number): FlowEdge[] => flow.edges.filter((e) => e.from === i && e.kind !== "loop");
  for (const b of boxes) {
    const outs = down(b.index);
    outs.forEach((edge, k) => {
      const sx = b.x + (NODE_W * (k + 1)) / (outs.length + 1);
      const sy = b.y + NODE_H;
      // Neighbouring port labels alternate height so long ones (otherwise) don't overprint.
      const ly = sy + 12 + (k % 2) * 10;
      if (typeof edge.to !== "number") {
        edges.push({ edge, d: `M${sx},${sy} V${sy + STUB}`, x: sx, y: ly, cap: { x: sx, y: sy + STUB + 12 } });
        return;
      }
      const t = boxes[edge.to]!;
      const tx = t.x + NODE_W / 2;
      const mid = (sy + t.y) / 2;
      edges.push({ edge, d: `M${sx},${sy} C${sx},${mid} ${tx},${mid} ${tx},${t.y}`, x: sx, y: ly });
    });
  }
  loops.forEach((edge, k) => {
    const s = boxes[edge.from]!;
    const t = boxes[edge.to as number]!;
    const lane = PAD + (loops.length - k) * LANE;
    const sy = s.y + NODE_H / 2 + 6;
    const ty = t.y + NODE_H / 2 - 6;
    edges.push({ edge, d: `M${s.x},${sy} H${lane} V${ty} H${t.x}`, x: lane + 4, y: sy - 4 });
  });

  const width = left + cols * (NODE_W + COL_GAP) - COL_GAP + PAD;
  const height = PAD + rows * (NODE_H + ROW_GAP) - ROW_GAP + STUB + 16 + PAD;
  return { boxes, edges, width, height, viewBox: `0 0 ${width} ${height}` };
}
