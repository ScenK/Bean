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
const BAR = 12; // a parallel group's fork/join bar, this far from the members' boxes

export interface FlowBox { index: number; x: number; y: number; row: number; col: number }
/** `d` is an SVG path; `x`/`y` place the edge's label; `cap` places an end/stop terminal. `repeat`:
 * a later fork of a bundle that already carries the label. */
export interface FlowLine { edge: FlowEdge; d: string; x: number; y: number; cap?: { x: number; y: number }; repeat?: true }
/** A parallel group's bar: above its members (forks meet it) or below them (joins meet it). */
export interface FlowBar { x1: number; x2: number; y: number; edges: FlowEdge[] }
export interface FlowLayout { boxes: FlowBox[]; edges: FlowLine[]; bars: FlowBar[]; width: number; height: number; viewBox: string }

/** Lays the flow out top to bottom: row = longest forward path from step 1, column = order of
 * first arrival (route paths side by side, a rejoin below them all), each row centred. Gate loops
 * (the only backward edges) are dashed lanes in a left gutter. A parallel group's members share a
 * row; its forks meet a bar above them and its joins a bar below, so a group never reads as a
 * route's exclusive paths. Pure and deterministic.
 * ponytail: no crossing minimization — a skip over a row draws through it; switch to dagre if
 * real sprouts tangle. */
export function layoutStepFlow(flow: { nodes: FlowNode[]; edges: FlowEdge[] }): FlowLayout {
  const n = flow.nodes.length;
  const row: (number | undefined)[] = flow.nodes.map(() => undefined);
  const arrival: number[] = flow.nodes.map(() => 0);
  // A group member's join target — the same for every member, so it names the group.
  const joinTo = (i: number): FlowEdge["to"] | undefined => flow.edges.find((e) => e.from === i && e.kind === "join")?.to;
  let seq = 0;
  // Forward edges only point to later steps, so index order is a topological order: a step's
  // row is final by the time it's visited. A step nothing reaches starts a row below the last.
  for (let i = 0; i < n; i++) {
    if (row[i] === undefined) {
      // A group that starts the sprout: nothing forks into it, its members still share a row.
      const sibling = i > 0 && joinTo(i) !== undefined && joinTo(i) === joinTo(i - 1);
      row[i] = i === 0 ? 0 : sibling ? row[i - 1]! : Math.max(...row.slice(0, i).map((r) => r!)) + 1;
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
  const bars = new Map<string, FlowBar>();
  // The group's bar above (fork) or below (join) its members' boxes, spanning their centres.
  const bar = (side: "fork" | "join", member: number, edge: FlowEdge): FlowBar => {
    const group = joinTo(member);
    const key = `${side}:${String(group)}`;
    let found = bars.get(key);
    if (!found) {
      const xs = boxes.filter((b) => joinTo(b.index) === group).map((b) => b.x + NODE_W / 2);
      const top = boxes[member]!.y;
      found = { x1: Math.min(...xs), x2: Math.max(...xs), y: side === "fork" ? top - BAR : top + NODE_H + BAR, edges: [] };
      bars.set(key, found);
    }
    found.edges.push(edge);
    return found;
  };
  // Each step's downward edges (forward + end/stop caps) leave from evenly spread ports; a bundle
  // of forks into one group shares a port.
  const down = (i: number): FlowEdge[] => flow.edges.filter((e) => e.from === i && e.kind !== "loop");
  for (const b of boxes) {
    const outs = down(b.index);
    const ports: unknown[] = [];
    const portOf = (e: FlowEdge): number => {
      const key = e.kind === "fork" ? `${e.via}:${e.label ?? ""}` : e;
      const p = ports.indexOf(key);
      return p >= 0 ? p : ports.push(key) - 1;
    };
    outs.forEach(portOf);
    outs.forEach((edge) => {
      const k = portOf(edge);
      const sx = b.x + (NODE_W * (k + 1)) / (ports.length + 1);
      const sy = b.y + NODE_H;
      // Neighbouring port labels alternate height so long ones (otherwise) don't overprint.
      const ly = sy + 12 + (k % 2) * 10;
      if (edge.kind === "fork" || edge.kind === "join") {
        const to = edge.to;
        const fork = edge.kind === "fork";
        const g = bar(edge.kind, fork ? (to as number) : b.index, edge);
        const bx = (g.x1 + g.x2) / 2;
        const first = g.edges.length === 1;
        if (fork) {
          // Source → the bar's middle → along it → down into this member.
          const t = boxes[to as number]!;
          const mid = (sy + g.y) / 2;
          edges.push({ edge, d: `M${sx},${sy} C${sx},${mid} ${bx},${mid} ${bx},${g.y} H${t.x + NODE_W / 2} V${t.y}`, x: sx, y: ly, ...(edges.some((l) => l.edge.kind === "fork" && l.edge.from === edge.from && portOf(l.edge) === k) ? { repeat: true as const } : {}) });
        } else if (typeof to === "number") {
          const t = boxes[to]!;
          const tx = t.x + NODE_W / 2;
          const mid = (g.y + t.y) / 2;
          edges.push({ edge, d: `M${sx},${sy} V${g.y} H${bx} C${bx},${mid} ${tx},${mid} ${tx},${t.y}`, x: sx, y: ly });
        } else {
          // One ● end under the bar, not one per member.
          edges.push({ edge, d: `M${sx},${sy} V${g.y} H${bx} V${g.y + STUB}`, x: sx, y: ly, ...(first ? { cap: { x: bx, y: g.y + STUB + 12 } } : {}) });
        }
        return;
      }
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
  const endsInGroup = flow.edges.some((e) => e.kind === "join" && typeof e.to !== "number");
  const height = PAD + rows * (NODE_H + ROW_GAP) - ROW_GAP + STUB + 16 + PAD + (endsInGroup ? BAR : 0);
  return { boxes, edges, bars: [...bars.values()], width, height, viewBox: `0 0 ${width} ${height}` };
}
