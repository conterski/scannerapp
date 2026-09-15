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
const SIDE_NAMES = ["top", "right", "bottom", "left"]; // by side type
const DEG = Math.PI / 180;

/** Sign per side that turns a midpoint coordinate into "how far out" it sits,
 *  so the four sides can be compared on one scale. */
const OUTWARD_SIGN = [-1, 1, 1, -1];

// A quad this far outside the frame (a share of each dimension) came from a
// bad line fit, not a document.
const OUT_OF_FRAME_TOLERANCE = 0.15;

// Sliver and near-degenerate quads are never documents.
const MIN_INTERNAL_ANGLE_DEG = 30;
const MAX_INTERNAL_ANGLE_DEG = 150;

// ------------------------------------------------------------------
// Scalars, points, segments and bounds
// ------------------------------------------------------------------

function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }

function shortSideOf(bounds) { return Math.min(bounds.width, bounds.height); }

function insideBounds(bounds, x, y) {
  return x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
}

/** Whether any of `points` lies further outside `bounds` than `tolerance`
 *  (a share of each dimension) allows. */
function outOfBounds(points, bounds, tolerance) {
  const { width, height } = bounds;
  return points.some((p) =>
    p.x < -tolerance * width || p.x > (1 + tolerance) * width ||
    p.y < -tolerance * height || p.y > (1 + tolerance) * height);
}

/** The point `t` of the way from `a` to `b`. Every probe that walks a side
 *  goes through this, so they all sample the same way. */
function pointAlong(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The pixel `depth` px from `point` along `normal`, rounded. */
function alongNormal(point, normal, depth) {
  return { x: Math.round(point.x + normal.nx * depth), y: Math.round(point.y + normal.ny * depth) };
}

/** The point at `u`, `v` (0..1 each) of a quad, bilinear in its corners. */
function bilinearInQuad({ tl, tr, br, bl }, u, v) {
  return pointAlong(pointAlong(tl, tr, u), pointAlong(bl, br, u), v);
}

function midpointOf(segment) {
  return { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
}

function segmentLength(segment) {
  return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
}

/** Angle of a segment in degrees, folded into (-90, 90]. */
function segmentAngleDeg(segment) {
  let angle = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x) / DEG;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return angle;
}

/** Vertical angles straddle ±90; folding them to [0, 180) makes them one cluster. */
function verticalAngleDeg(segment) {
  const angle = segmentAngleDeg(segment);
  return angle < 0 ? angle + 180 : angle;
}

/** Smallest angle between two folded angles, 0..90. */
function angleDifferenceDeg(first, second) {
  const difference = Math.abs(first - second) % 180;
  return Math.min(difference, 180 - difference);
}

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
      ? Math.acos(clamp(dot / magnitude, -1, 1)) / DEG
      : 0);
  }
  return angles;
}

function hasDegenerateAngle(quad) {
  return internalAngles(quad).some(
    (angle) => angle < MIN_INTERNAL_ANGLE_DEG || angle > MAX_INTERNAL_ANGLE_DEG);
}

function boundingBoxOfPoints(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const point of points) {
    x0 = Math.min(x0, point.x); y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x); y1 = Math.max(y1, point.y);
  }
  return { x0, y0, x1, y1 };
}

function bboxOf(quad) { return boundingBoxOfPoints(quadPoints(quad)); }

/** Intersection over union of two quads' areas. */
function quadIoU(a, b) {
  const intersection = polygonArea(clipPolyToQuad(quadPoints(a), b));
  const union = shoelaceArea(a) + shoelaceArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
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

/** Reads one side. Called several times per clip, per containment test and per
 *  side move, so it builds only the side asked for rather than all four plus
 *  an array to hold them. Fixed property names on purpose — looking the corner
 *  pair up by key measured slower than the allocation it saved. */
function sideOf(quad, type) {
  switch (type) {
    case SIDE_TOP: return { a: quad.tl, b: quad.tr };
    case SIDE_RIGHT: return { a: quad.tr, b: quad.br };
    case SIDE_BOTTOM: return { a: quad.br, b: quad.bl };
    default: return { a: quad.bl, b: quad.tl };
  }
}

/** The side lines of a quad, indexed by side type. */
function sideLinesOf(quad) {
  const lines = [];
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    lines.push(lineThrough(side.a, side.b));
  }
  return lines;
}

/** How far from a rectangle a quad's sides are: `opposite` is the larger
 *  of the two opposite-side length ratios (top to bottom, left to right),
 *  `aspect` the mean horizontal side over the mean vertical one — each the
 *  longer over the shorter, so both are >= 1. */
function sideRatios(quad) {
  const length = (type) => segmentLength(sideOf(quad, type));
  const ratio = (first, second) => Math.max(first, second) / Math.max(1e-6, Math.min(first, second));
  const top = length(SIDE_TOP), bottom = length(SIDE_BOTTOM), left = length(SIDE_LEFT), right = length(SIDE_RIGHT);
  return { opposite: Math.max(ratio(top, bottom), ratio(left, right)), aspect: ratio((top + bottom) / 2, (left + right) / 2) };
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

/** Unit normal of `side`, flipped to point away from `center`. The probes work
 *  from a centroid they were handed rather than from a quad, so the flip lives
 *  here and outwardNormal is the quad-shaped wrapper around it. */
function outwardNormalFrom(side, center) {
  const length = segmentLength(side) || 1;
  let nx = -(side.b.y - side.a.y) / length;
  let ny = (side.b.x - side.a.x) / length;
  const mid = midpointOf(side);
  if (nx * (center.x - mid.x) + ny * (center.y - mid.y) > 0) { nx = -nx; ny = -ny; }
  return { nx, ny };
}

/** Outward-pointing unit normal of a quad side (away from the centroid). */
function outwardNormal(quad, side) {
  return outwardNormalFrom(side, centroidOf(quad));
}

/* A "line" is infinite: { px, py, dx, dy }, a point on it and its unit
 * direction. A "segment" or "side" is { a, b }. */

function lineThrough(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { px: a.x, py: a.y, dx: (b.x - a.x) / length, dy: (b.y - a.y) / length };
}

/** `line` moved by `distance` along `normal`. */
function shiftedLine(line, normal, distance) {
  return { px: line.px + normal.nx * distance, py: line.py + normal.ny * distance, dx: line.dx, dy: line.dy };
}

/** The line a side lies on, shifted `distance` px along its outward normal. */
function offsetSideLine(side, normal, distance) {
  return shiftedLine(lineThrough(side.a, side.b), normal, distance);
}

/** Perpendicular distance from a point to a line. */
function distanceToLine(point, line) {
  return Math.abs((point.x - line.px) * line.dy - (point.y - line.py) * line.dx);
}

/** Where `point` projects onto `line`, as a distance along it from (px, py). */
function projectionAlong(point, line) {
  return (point.x - line.px) * line.dx + (point.y - line.py) * line.dy;
}

/** The stretch of `line` that `points` cover: a segment between the
 *  projections of the outermost of them. */
function spanAlongLine(line, points) {
  let first = Infinity, last = -Infinity;
  for (const point of points) {
    const along = projectionAlong(point, line);
    first = Math.min(first, along);
    last = Math.max(last, along);
  }
  return {
    a: { x: line.px + line.dx * first, y: line.py + line.dy * first },
    b: { x: line.px + line.dx * last, y: line.py + line.dy * last },
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

/** The four corners four side lines (indexed by side type) meet at, in
 *  corner order tl, tr, br, bl; null where neighbouring lines are parallel. */
function cornersOfSideLines(lines) {
  return [
    lineIntersect(lines[SIDE_LEFT], lines[SIDE_TOP]),
    lineIntersect(lines[SIDE_TOP], lines[SIDE_RIGHT]),
    lineIntersect(lines[SIDE_RIGHT], lines[SIDE_BOTTOM]),
    lineIntersect(lines[SIDE_BOTTOM], lines[SIDE_LEFT]),
  ];
}

function validQuadOrNull(points, bounds, tolerance = OUT_OF_FRAME_TOLERANCE) {
  if (points.some((p) => !p || !isFinite(p.x) || !isFinite(p.y))) return null;
  if (outOfBounds(points, bounds, tolerance)) return null;
  const quad = orderCorners(points);
  if (!quad) return null;
  return hasDegenerateAngle(quad) ? null : quad;
}

/** Intersects four side lines (indexed by side type) back into a quad.
 *  Every side-moving pass in the detector ends this way.
 *  @param tolerance how far outside `bounds` a corner may land; the default
 *                   is OUT_OF_FRAME_TOLERANCE */
function quadFromSideLines(lines, bounds, tolerance) {
  return validQuadOrNull(cornersOfSideLines(lines), bounds, tolerance);
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
  return clamp(1 - inside / total, 0, 1);
}

/** Fraction of `polygon`'s area cut off by ONE side of `quad`. */
function fracCutBySide(polygon, quad, type) {
  const total = polygonArea(polygon);
  if (total <= 0) return 0;
  const side = sideOf(quad, type);
  const kept = clipPolygonToHalfPlane(polygon, side, centroidOf(quad));
  return clamp(1 - polygonArea(kept) / total, 0, 1);
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
