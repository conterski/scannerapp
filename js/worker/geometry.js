/* worker/geometry.js — pure quad and polygon geometry for the detector.
 * No OpenCV, no pixels: everything here is arithmetic on {x, y} points, which
 * is what makes it the easy half of the detector to reason about.
 *
 * A "quad" is always {tl, tr, br, bl}. A "side type" is an index into that
 * ring: 0 top (tl→tr), 1 right (tr→br), 2 bottom (br→bl), 3 left (bl→tl).
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

/* Anything sized takes a `bounds`: { width, height }. The pixel `image` and
 * the detect `pipeline` are both supersets of that shape, so callers hand in
 * whichever they already hold. */

const SIDE_COUNT = 4;
const SIDE_TOP = 0, SIDE_RIGHT = 1, SIDE_BOTTOM = 2, SIDE_LEFT = 3;

/** Sign per side that turns a midpoint coordinate into "how far out" it sits,
 *  so the four sides can be compared on one scale. */
const OUTWARD_SIGN = [-1, 1, 1, -1];

// A quad this far outside the frame came from a bad line fit, not a document.
const OUT_OF_FRAME_TOLERANCE = 0.15;

// Sliver and near-degenerate quads are never documents.
const MIN_INTERNAL_ANGLE_DEG = 30;
const MAX_INTERNAL_ANGLE_DEG = 150;

// ------------------------------------------------------------------
// Areas and corner ordering
// ------------------------------------------------------------------

function quadPoints(quad) { return [quad.tl, quad.tr, quad.br, quad.bl]; }

/** Shoelace area of an arbitrary point-array polygon. */
function polygonArea(points) {
  let doubleArea = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    doubleArea += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(doubleArea) / 2;
}

function shoelaceArea(quad) { return polygonArea(quadPoints(quad)); }

/** Labels four unordered points tl/tr/br/bl by coordinate sum and difference.
 *  Returns null when two labels land on the same point (degenerate). */
function orderCorners(points) {
  let topLeft, topRight, bottomRight, bottomLeft;
  let minSum = Infinity, maxSum = -Infinity;
  let minDiff = Infinity, maxDiff = -Infinity;
  for (const point of points) {
    const sum = point.x + point.y;
    const diff = point.x - point.y;
    if (sum < minSum) { minSum = sum; topLeft = point; }
    if (sum > maxSum) { maxSum = sum; bottomRight = point; }
    if (diff > maxDiff) { maxDiff = diff; topRight = point; }
    if (diff < minDiff) { minDiff = diff; bottomLeft = point; }
  }
  const labelled = [topLeft, topRight, bottomRight, bottomLeft];
  if (new Set(labelled).size !== SIDE_COUNT) return null;
  return { tl: topLeft, tr: topRight, br: bottomRight, bl: bottomLeft };
}

function internalAngles(quad) {
  const points = quadPoints(quad);
  const angles = [];
  for (let i = 0; i < SIDE_COUNT; i++) {
    const previous = points[(i + 3) % SIDE_COUNT];
    const vertex = points[i];
    const next = points[(i + 1) % SIDE_COUNT];
    const toPrevious = { x: previous.x - vertex.x, y: previous.y - vertex.y };
    const toNext = { x: next.x - vertex.x, y: next.y - vertex.y };
    const dot = toPrevious.x * toNext.x + toPrevious.y * toNext.y;
    const magnitude = Math.hypot(toPrevious.x, toPrevious.y) * Math.hypot(toNext.x, toNext.y);
    angles.push(magnitude > 0
      ? (Math.acos(Math.max(-1, Math.min(1, dot / magnitude))) * 180) / Math.PI
      : 0);
  }
  return angles;
}

function hasDegenerateAngle(quad) {
  return internalAngles(quad).some(
    (angle) => angle < MIN_INTERNAL_ANGLE_DEG || angle > MAX_INTERNAL_ANGLE_DEG);
}

function bboxOf(quad) {
  const xs = quadPoints(quad).map((point) => point.x);
  const ys = quadPoints(quad).map((point) => point.y);
  return {
    x0: Math.min(...xs), y0: Math.min(...ys),
    x1: Math.max(...xs), y1: Math.max(...ys),
  };
}

function bboxIoU(a, b) {
  const overlapX = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const overlapY = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const intersection = overlapX * overlapY;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - intersection;
  return union > 0 ? intersection / union : 0;
}

function centroidOf(quad) {
  const points = quadPoints(quad);
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / SIDE_COUNT,
    y: points.reduce((sum, p) => sum + p.y, 0) / SIDE_COUNT,
  };
}

// ------------------------------------------------------------------
// Sides, lines and intersections
// ------------------------------------------------------------------

function sideOf(quad, type) {
  return [
    { a: quad.tl, b: quad.tr }, { a: quad.tr, b: quad.br },
    { a: quad.br, b: quad.bl }, { a: quad.bl, b: quad.tl },
  ][type];
}

/** How far out this side sits, on the one scale all four sides share.
 *  Horizontal sides are measured by their mid-y, vertical ones by mid-x. */
function sideOutwardness(side, type) {
  const midpoint = type % 2 === 0 ? (side.a.y + side.b.y) / 2 : (side.a.x + side.b.x) / 2;
  return OUTWARD_SIGN[type] * midpoint;
}

function quadSideOutwardness(quad, type) {
  return sideOutwardness(sideOf(quad, type), type);
}

/** Outward-pointing unit normal of a quad side (away from the centroid). */
function outwardNormal(quad, side) {
  const center = centroidOf(quad);
  const length = Math.hypot(side.b.x - side.a.x, side.b.y - side.a.y) || 1;
  let nx = -(side.b.y - side.a.y) / length;
  let ny = (side.b.x - side.a.x) / length;
  const midX = (side.a.x + side.b.x) / 2;
  const midY = (side.a.y + side.b.y) / 2;
  if (nx * (center.x - midX) + ny * (center.y - midY) > 0) { nx = -nx; ny = -ny; }
  return { nx, ny };
}

function lineThrough(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { px: a.x, py: a.y, dx: (b.x - a.x) / length, dy: (b.y - a.y) / length };
}

/** The line a side lies on, shifted `distance` px along its outward normal. */
function offsetSideLine(side, normal, distance) {
  const length = Math.hypot(side.b.x - side.a.x, side.b.y - side.a.y) || 1;
  return {
    px: side.a.x + normal.nx * distance,
    py: side.a.y + normal.ny * distance,
    dx: (side.b.x - side.a.x) / length,
    dy: (side.b.y - side.a.y) / length,
  };
}

function lineIntersect(first, second) {
  const denominator = first.dx * second.dy - first.dy * second.dx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((second.px - first.px) * second.dy -
             (second.py - first.py) * second.dx) / denominator;
  return { x: first.px + t * first.dx, y: first.py + t * first.dy };
}

function distToSegLine(point, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const length = Math.hypot(abx, aby);
  if (length < 1e-9) return Infinity;
  return Math.abs((point.x - a.x) * aby - (point.y - a.y) * abx) / length;
}

/** Least-squares line through a point cloud, as {px, py, dx, dy}. */
function fitLinePts(points) {
  let meanX = 0, meanY = 0;
  for (const point of points) { meanX += point.x; meanY += point.y; }
  meanX /= points.length; meanY /= points.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const point of points) {
    const dx = point.x - meanX, dy = point.y - meanY;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: meanX, py: meanY, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function validQuadOrNull(points, bounds) {
  const { width, height } = bounds;
  if (points.some((p) => !p || !isFinite(p.x) || !isFinite(p.y))) return null;
  if (points.some((p) =>
    p.x < -OUT_OF_FRAME_TOLERANCE * width || p.x > (1 + OUT_OF_FRAME_TOLERANCE) * width ||
    p.y < -OUT_OF_FRAME_TOLERANCE * height || p.y > (1 + OUT_OF_FRAME_TOLERANCE) * height)) {
    return null;
  }
  const quad = orderCorners(points);
  if (!quad) return null;
  return hasDegenerateAngle(quad) ? null : quad;
}

/** Intersects four side lines (indexed by side type) back into a quad.
 *  Every side-moving pass in the detector ends this way. */
function quadFromSideLines(lines, bounds) {
  return validQuadOrNull([
    lineIntersect(lines[SIDE_LEFT], lines[SIDE_TOP]),
    lineIntersect(lines[SIDE_TOP], lines[SIDE_RIGHT]),
    lineIntersect(lines[SIDE_RIGHT], lines[SIDE_BOTTOM]),
    lineIntersect(lines[SIDE_BOTTOM], lines[SIDE_LEFT]),
  ], bounds);
}

// ------------------------------------------------------------------
// Clipping and containment
// ------------------------------------------------------------------

/** Which side of line a→b a point falls on. */
function crossOfLine(a, b, point) {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

/** Clips `polygon` to the inside half-plane of `line` ({a, b}), where "inside"
 *  is whichever side `reference` sits on. */
function clipPolygonToHalfPlane(polygon, line, reference) {
  const { a, b } = line;
  const insideSign = crossOfLine(a, b, reference) >= 0 ? 1 : -1;
  const kept = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currentSide = insideSign * crossOfLine(a, b, current);
    const nextSide = insideSign * crossOfLine(a, b, next);
    if (currentSide >= 0) kept.push(current);
    if ((currentSide >= 0) !== (nextSide >= 0)) {
      const t = currentSide / (currentSide - nextSide);
      kept.push({
        x: current.x + t * (next.x - current.x),
        y: current.y + t * (next.y - current.y),
      });
    }
  }
  return kept;
}

/** Sutherland–Hodgman clip of `polygon` against convex quad `quad`. The
 *  inside sign per edge comes from the quad centroid, so winding order never
 *  matters. Returns the clipped points (empty when disjoint). */
function clipPolyToQuad(polygon, quad) {
  const center = centroidOf(quad);
  let points = polygon;
  for (let type = 0; type < SIDE_COUNT; type++) {
    points = clipPolygonToHalfPlane(points, sideOf(quad, type), center);
    if (!points.length) break;
  }
  return points;
}

/** Fraction of `polygon`'s area lying OUTSIDE `quad` (0..1). */
function fracOutsideQuad(polygon, quad) {
  const total = polygonArea(polygon);
  if (total <= 0) return 1;
  const inside = polygonArea(clipPolyToQuad(polygon, quad));
  return Math.min(1, Math.max(0, 1 - inside / total));
}

/** Fraction of `polygon`'s area cut off by ONE side of `quad`. */
function fracCutBySide(polygon, quad, type) {
  const total = polygonArea(polygon);
  if (total <= 0) return 0;
  const side = sideOf(quad, type);
  const kept = clipPolygonToHalfPlane(polygon, side, centroidOf(quad));
  return Math.min(1, Math.max(0, 1 - polygonArea(kept) / total));
}

/** True if `point` is inside convex `quad` (centroid-sign test). */
function pointInQuad(point, quad) {
  const center = centroidOf(quad);
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    const insideSign = crossOfLine(side.a, side.b, center) >= 0 ? 1 : -1;
    if (insideSign * crossOfLine(side.a, side.b, point) < 0) return false;
  }
  return true;
}

// ------------------------------------------------------------------
// Grow-only side moves
// ------------------------------------------------------------------

/** How far past `side` the furthest of `points` sits, along the outward
 *  normal. Zero when nothing pokes out. */
function overhangBeyondSide(side, normal, points) {
  let furthest = 0;
  for (const point of points) {
    const distance = normal.nx * (point.x - side.a.x) + normal.ny * (point.y - side.a.y);
    if (distance > furthest) furthest = distance;
  }
  return furthest;
}

/** Pushes ONE side of `quad` outward until it clears every point in
 *  `coverage.points`.
 *  @param coverage { points, bounds } */
function coverSide(quad, type, coverage) {
  const lines = [];
  for (let sideType = 0; sideType < SIDE_COUNT; sideType++) {
    const side = sideOf(quad, sideType);
    if (sideType !== type) {
      lines.push(lineThrough(side.a, side.b));
      continue;
    }
    const normal = outwardNormal(quad, side);
    lines.push(offsetSideLine(side, normal,
      overhangBeyondSide(side, normal, coverage.points)));
  }
  return quadFromSideLines(lines, coverage.bounds) || quad;
}

/**
 * Grow-only cover: shifts EVERY side outward until every point in `points` is
 * inside. Hull simplification can drop an occluded-corner vertex, leaving a
 * diagonal that slices the paper; covering repairs that, so a split part's
 * quad can never cut its own content. Falls back to `quad`.
 */
function coverQuad(quad, points, bounds) {
  const lines = [];
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    const normal = outwardNormal(quad, side);
    lines.push(offsetSideLine(side, normal, overhangBeyondSide(side, normal, points)));
  }
  return quadFromSideLines(lines, bounds) || quad;
}

/** Pushes every side outward by `margin` px, so hairline errors land on
 *  background instead of clipping document content. */
function expandQuad(quad, margin, bounds) {
  const lines = [];
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    lines.push(offsetSideLine(side, outwardNormal(quad, side), margin));
  }
  return quadFromSideLines(lines, bounds) || quad;
}
