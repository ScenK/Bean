export interface Point { x: number; y: number; }

// Quick-actions and the drag-skill bloom both render as a vertical stack of tiles growing
// downward from the bean (see the mockup at ~/Develop/Desktop Quick Action App). Tiles share
// one column x; the y's step down evenly from the first tile below the bean.
// ponytail: fixed downward column + naive nearest-neighbor hit test. Add up/side flipping or
// paging only if tiles start clipping off-screen for real skill counts.
export function computeStackPositions(
  count: number,
  columnX: number,
  firstY: number,
  step: number,
): Point[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => ({ x: columnX, y: firstY + i * step }));
}

export function nearestPetalIndex(x: number, y: number, positions: Point[], maxDist: number): number | undefined {
  let best: number | undefined;
  let bestDist = maxDist;
  positions.forEach((p, i) => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// Precise "is the pointer over this element" check (edges count as inside), same shape as
// DOMRect so callers can pass el.getBoundingClientRect() directly. Used to give the bean's own
// box precedence over petal-proximity snapping: without it, dropping on the box itself could
// still resolve to the nearest petal purely by distance, implicitly firing a skill nobody chose.
export function pointInRect(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
