// The detector's pure geometry (js/worker/geometry.js): the arithmetic every
// crop decision rests on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "../helpers/load-script.mjs";

const worker = loadScripts(["js/worker/geometry.js"]);
const square = (size, x = 0, y = 0) => ({
  tl: { x, y }, tr: { x: x + size, y }, br: { x: x + size, y: y + size }, bl: { x, y: y + size },
});

test("polygonArea is the shoelace area, whichever the winding", () => {
  const { tl, tr, br, bl } = square(10);
  assert.equal(worker.polygonArea([tl, tr, br, bl]), 100);
  assert.equal(worker.polygonArea([bl, br, tr, tl]), 100);
});

test("orderCorners labels four loose points by position", () => {
  const { tl, tr, br, bl } = square(10, 5, 5);
  // Spread: the result is built in the script's own realm, with its own Object prototype.
  assert.deepEqual({ ...worker.orderCorners([br, tl, bl, tr]) }, { tl, tr, br, bl });
});

test("orderCorners refuses a degenerate set", () => {
  const point = { x: 1, y: 1 };
  assert.equal(worker.orderCorners([point, point, point, point]), null);
});

test("quadIoU is 1 for the same quad, 0 for disjoint ones, and a share between", () => {
  assert.equal(worker.quadIoU(square(10), square(10)), 1);
  assert.equal(worker.quadIoU(square(10), square(10, 50, 50)), 0);
  assert.ok(Math.abs(worker.quadIoU(square(10), square(10, 5, 0)) - 50 / 150) < 1e-9);
});

test("lineIntersect meets two lines, and gives up on parallel ones", () => {
  const horizontal = worker.lineThrough({ x: 0, y: 5 }, { x: 10, y: 5 });
  const vertical = worker.lineThrough({ x: 3, y: 0 }, { x: 3, y: 10 });
  const point = worker.lineIntersect(horizontal, vertical);
  assert.ok(Math.abs(point.x - 3) < 1e-9 && Math.abs(point.y - 5) < 1e-9);
  assert.equal(worker.lineIntersect(horizontal, worker.lineThrough({ x: 0, y: 9 }, { x: 10, y: 9 })), null);
});

test("expandQuad pushes every side out by the margin", () => {
  const grown = worker.expandQuad(square(100, 100, 100), 10, { width: 1000, height: 1000 });
  assert.ok(Math.abs(worker.shoelaceArea(grown) - 120 * 120) < 1e-6);
  assert.ok(Math.abs(grown.tl.x - 90) < 1e-9 && Math.abs(grown.br.y - 210) < 1e-9);
});
