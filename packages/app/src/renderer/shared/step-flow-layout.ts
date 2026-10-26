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
const FRAME = 8; // a parallel group's frame, this far outside its members' boxes

export interface FlowBox { index: number; x: number; y: number; row: number; col: number }
/** `d` is an SVG path; `x`/`y` place the edge's label; `cap` places an end/stop terminal. `repeat`:
 * a later edge of a bundle (forks into a group, a group's joins) — same curve, drawn once. */
export interface FlowLine { edge: FlowEdge; d: string; x: number; y: number; cap?: { x: number; y: number }; repeat?: true }
/** A parallel group's frame around its members, steps `first`..`first + n - 1`. */
export interface FlowGroup { x: number; y: number; w: number; h: number; first: number; n: number }
export interface FlowLayout { boxes: FlowBox[]; edges: FlowLine[]; groups: FlowGroup[]; width: number; height: number; viewBox: string }

/** Lays the flow out top to bottom: row = longest forward path from step 1, column = order of
 * first arrival (route paths side by side, a rejoin below them all), each row centred. Gate loops
 * (the only backward edges) are dashed lanes in a left gutter. A parallel group's members share a
 * row inside one labelled frame that its forks enter and its joins leave, so a group never reads
 * as a route's exclusive paths. Pure and deterministic.
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

  // A parallel group's frame: FRAME around its members' boxes (they share a row), inside the gap
  // a fork or join would otherwise curve through, so the layout doesn't grow.
  const groups = new Map<FlowEdge["to"], FlowGroup>();
  for (const key of new Set(boxes.map((b) => joinTo(b.index)))) {
    if (key === undefined) continue;
    const members = boxes.filter((b) => joinTo(b.index) === key);
    const x = Math.min(...members.map((b) => b.x)) - FRAME;
    const w = Math.max(...members.map((b) => b.x)) + NODE_W + FRAME - x;
    groups.set(key, { x, y: members[0]!.y - FRAME, w, h: NODE_H + 2 * FRAME, first: members[0]!.index, n: members.length });
  }
  const frameOf = (i: number): FlowGroup | undefined => {
    const key = joinTo(i);
    return key === undefined ? undefined : groups.get(key);
  };

  const edges: FlowLine[] = [];
  // Each step's downward edges (forward + end/stop caps) leave from evenly spread ports; a bundle
  // of forks into one group shares a port. A group's joins all leave its frame's bottom centre,
  // and an edge into a group ends at its frame's top centre — so a bundle is one drawn curve.
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
    // Members only join, so a member's every edge leaves its frame.
    const src = frameOf(b.index);
    outs.forEach((edge) => {
      const k = portOf(edge);
      const sx = src ? src.x + src.w / 2 : b.x + (NODE_W * (k + 1)) / (ports.length + 1);
      const sy = src ? src.y + src.h : b.y + NODE_H;
      // Neighbouring port labels alternate height so long ones (otherwise) don't overprint.
      const ly = sy + 12 + (k % 2) * 10;
      let line: FlowLine;
      if (typeof edge.to !== "number") {
        line = { edge, d: `M${sx},${sy} V${sy + STUB}`, x: sx, y: ly, cap: { x: sx, y: sy + STUB + 12 } };
      } else {
        const dst = frameOf(edge.to);
        const t = boxes[edge.to]!;
        const tx = dst ? dst.x + dst.w / 2 : t.x + NODE_W / 2;
        const ty = dst ? dst.y : t.y;
        const mid = (sy + ty) / 2;
        line = { edge, d: `M${sx},${sy} C${sx},${mid} ${tx},${mid} ${tx},${ty}`, x: sx, y: ly };
      }
      // A later edge of a bundle draws the same curve: it's emitted (overlay indexes every edge) but
      // drawn once, with the bundle's label and cap.
      if (edges.some((l) => l.d === line.d)) {
        delete line.cap;
        line.repeat = true;
      }
      edges.push(line);
    });
  }
  loops.forEach((edge, k) => {
    const s = boxes[edge.from]!;
    const t = boxes[edge.to as number]!;
    const lane = PAD + (loops.length - k) * LANE;
    const sy = s.y + NODE_H / 2 + 6;
    const ty = t.y + NODE_H / 2 - 6;
    edges.push({ edge, d: `M${s.x},${sy} H${lane} V${ty} H${frameOf(edge.to as number)?.x ?? t.x}`, x: lane + 4, y: sy - 4 });
  });

  const width = left + cols * (NODE_W + COL_GAP) - COL_GAP + PAD;
  const endsInGroup = flow.edges.some((e) => e.kind === "join" && typeof e.to !== "number");
  const height = PAD + rows * (NODE_H + ROW_GAP) - ROW_GAP + STUB + 16 + PAD + (endsInGroup ? FRAME : 0);
  return { boxes, edges, groups: [...groups.values()], width, height, viewBox: `0 0 ${width} ${height}` };
}
