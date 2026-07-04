import { expect, test } from "vitest";
import { createDragPreparationGate } from "../src/drag-preparation.js";
import { computeStackPositions, nearestPetalIndex, pointInRect } from "../src/petal-geometry.js";

test("returns no tiles for zero count", () => {
  expect(computeStackPositions(0, 100, 100, 60)).toEqual([]);
});

test("tiles share one column x and step evenly downward from firstY", () => {
  const positions = computeStackPositions(3, 200, 150, 60);
  expect(positions).toEqual([
    { x: 200, y: 150 },
    { x: 200, y: 210 },
    { x: 200, y: 270 },
  ]);
});

test("nearestPetalIndex returns the closest tile within maxDist", () => {
  const positions = [{ x: 10, y: 10 }, { x: 100, y: 100 }];
  expect(nearestPetalIndex(12, 11, positions, 20)).toBe(0);
  expect(nearestPetalIndex(98, 102, positions, 20)).toBe(1);
});

test("nearestPetalIndex returns undefined when nothing is within maxDist", () => {
  const positions = [{ x: 10, y: 10 }, { x: 100, y: 100 }];
  expect(nearestPetalIndex(500, 500, positions, 20)).toBeUndefined();
});

test("pointInRect is true for a point inside (or on the edge of) the rect", () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 50 };
  expect(pointInRect(50, 25, rect)).toBe(true);
  expect(pointInRect(0, 0, rect)).toBe(true); // edges count as inside
  expect(pointInRect(100, 50, rect)).toBe(true);
});

test("pointInRect is false for a point outside the rect", () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 50 };
  expect(pointInRect(-1, 25, rect)).toBe(false);
  expect(pointInRect(50, 51, rect)).toBe(false);
});

test("drag preparation gate rejects duplicate drag enters while preparation is pending", () => {
  const gate = createDragPreparationGate();

  expect(gate.begin()).toBe(true);
  expect(gate.begin()).toBe(false);
  gate.end();
  expect(gate.begin()).toBe(true);
});
