/* worker/quad-refine.js — the passes that run after a quad has been chosen:
 * fitting its corners from its edges, marching each side outward to recover
 * strips every mask missed, and deciding which region the anti-cut net is
 * allowed to protect.
 *
 * All three exist to serve the same bias: including a sliver of background is
 * acceptable, cutting document content is not.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

// refineQuadEdges: hull points near a corner are rounded, so they pollute the
// edge fits and are skipped; the rest are assigned to their nearest side.
const CORNER_EXCLUSION_FRACTION = 0.05;   // of the quad perimeter
const SIDE_ASSIGNMENT_FRACTION = 0.03;    // of the quad perimeter
const REFINED_OUT_OF_FRAME_TOLERANCE = 0.1;

// snapSidesOutward: how far a side may march, and what stops it.
const MAX_MARCH_FRACTION = 0.1;
const STRONG_EDGE_CONTRAST = 0.55;        // a side already on a real edge must not move
const PAPER_REFERENCE_INSET = 6;
const MARCH_STEP = 2;
const HARD_EDGE_DIFF = 20;                // an unmistakable step
const SOFT_EDGE_DIFF = 9;                 // white paper on a near-white background
const SOFT_EDGE_SUSTAIN = 10;             // …only counts if it persists this far
const THIN_LINE_PEEK = 12;                // hop a printed border line this wide
const MIN_MARCH_SAMPLES = 5;
const MIN_USEFUL_MARCH = 3;
const STOP_SPREAD_FLOOR = 6;
const STOP_SPREAD_RATIO = 0.5;
const MAX_SNAP_GROWTH = 1.2;              // the snap may only grow, never explode
const MAX_SNAP_IMAGE_COVERAGE = 1.03;

// consensusHull: which candidates may clip the protected region, and how much
// of it they may remove.
const CLIPPER_MIN_SCORE_RATIO = 0.3;
const CLIPPER_MIN_BBOX_IOU = 0.6;
const TIER2_MIN_AREA_RATIO = 0.7;
const TIER2_TWIN_MIN_IOU = 0.8;
const MAX_SINGLE_CLIP = 0.55;             // one clipper may not remove >45%
const MIN_KEPT_AFTER_CLIPPING = 0.45;

// Sample positions along a side, shared by the march and its reference.
const SIDE_SAMPLE_START = 0.12;
const SIDE_SAMPLE_END = 0.89;
const SIDE_SAMPLE_STEP = 0.096;

function sideSampleFractions() {
  const fractions = [];
  for (let t = SIDE_SAMPLE_START; t <= SIDE_SAMPLE_END; t += SIDE_SAMPLE_STEP) {
    fractions.push(t);
  }
  return fractions;
}

// ------------------------------------------------------------------
// Corner refinement
// ------------------------------------------------------------------

function quadPerimeter(corners, sides) {
  return sides.reduce((total, [from, to]) => total + Math.hypot(
    corners[to].x - corners[from].x, corners[to].y - corners[from].y), 0);
}

/**
 * Refines a quad by assigning hull points to their nearest side, fitting a
 * straight line per side (least squares), and intersecting adjacent lines.
 * Corners come from the EDGES, so rounded or clipped hull corners don't drag
 * them inward.
 */
function refineQuadEdges(quad, hullPts, width, height) {
  const corners = quadPoints(quad);
  const sides = [[0, 1], [1, 2], [2, 3], [3, 0]]; // top, right, bottom, left
  const perimeter = quadPerimeter(corners, sides);
  const cornerRadius = CORNER_EXCLUSION_FRACTION * perimeter;
  const maxAssignmentDistance = SIDE_ASSIGNMENT_FRACTION * perimeter;

  const pointsPerSide = [[], [], [], []];
  for (const point of hullPts) {
    if (corners.some((corner) =>
      Math.hypot(point.x - corner.x, point.y - corner.y) < cornerRadius)) continue;
    let nearestSide = -1, nearestDistance = Infinity;
    for (let side = 0; side < SIDE_COUNT; side++) {
      const distance = distToSegLine(point, corners[sides[side][0]], corners[sides[side][1]]);
      if (distance < nearestDistance) { nearestDistance = distance; nearestSide = side; }
    }
    if (nearestSide >= 0 && nearestDistance < maxAssignmentDistance) {
      pointsPerSide[nearestSide].push(point);
    }
  }

  // Anchor each fit with the quad corners so sparse sides stay sane.
  const lines = sides.map(([from, to], side) =>
    fitLinePts(pointsPerSide[side].concat([corners[from], corners[to]])));

  const refined = [];
  for (let i = 0; i < SIDE_COUNT; i++) {
    const corner = lineIntersect(lines[(i + 3) % SIDE_COUNT], lines[i]);
    if (!corner || !isFinite(corner.x) || !isFinite(corner.y)) return quad;
    // A refined corner far outside the image means a bad fit — keep the original.
    if (corner.x < -REFINED_OUT_OF_FRAME_TOLERANCE * width ||
        corner.x > (1 + REFINED_OUT_OF_FRAME_TOLERANCE) * width ||
        corner.y < -REFINED_OUT_OF_FRAME_TOLERANCE * height ||
        corner.y > (1 + REFINED_OUT_OF_FRAME_TOLERANCE) * height) return quad;
    refined.push(corner);
  }
  return orderCorners(refined) || quad;
}

// ------------------------------------------------------------------
// Outward snap
// ------------------------------------------------------------------

/** Median gray just inside the side — a robust "this is the paper" value that
 *  text or artwork under one sample can't poison. */
function paperReferenceAlongSide(image, side, normal, fractions) {
  const samples = [];
  for (const t of fractions) {
    const x = Math.round(side.a.x + (side.b.x - side.a.x) * t - normal.nx * PAPER_REFERENCE_INSET);
    const y = Math.round(side.a.y + (side.b.y - side.a.y) * t - normal.ny * PAPER_REFERENCE_INSET);
    if (isInsideImage(image, x, y)) samples.push(grayAt(image, x, y));
  }
  if (samples.length < MIN_MARCH_SAMPLES) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/** A thin dark run (a printed border line) with paper resuming right behind it
 *  is not the document edge. Returns the distance to hop to, or 0.
 *  @param march { point, normal, reference, maxMarch } */
function distancePastThinLine(image, march, from) {
  for (let peek = from + MARCH_STEP;
       peek <= Math.min(from + THIN_LINE_PEEK, march.maxMarch);
       peek += MARCH_STEP) {
    const x = Math.round(march.point.x + march.normal.nx * peek);
    const y = Math.round(march.point.y + march.normal.ny * peek);
    if (!isInsideImage(image, x, y)) return 0;
    if (Math.abs(grayAt(image, x, y) - march.reference) <= HARD_EDGE_DIFF) return peek;
  }
  return 0;
}

/** Marches outward from one point on a side until it meets the real edge.
 *  Returns the distance, or null when no edge was confirmed.
 *  @param march { point, normal, reference, maxMarch } */
function marchToEdge(image, march) {
  let distance = 0;
  let softStart = -1;
  for (let step = MARCH_STEP; step <= march.maxMarch; step += MARCH_STEP) {
    const x = Math.round(march.point.x + march.normal.nx * step);
    const y = Math.round(march.point.y + march.normal.ny * step);
    if (!isInsideImage(image, x, y)) return null;
    const difference = Math.abs(grayAt(image, x, y) - march.reference);

    if (difference > HARD_EDGE_DIFF) {
      const resumeAt = distancePastThinLine(image, march, step);
      if (resumeAt) { distance = resumeAt; step = resumeAt; softStart = -1; continue; }
      return distance;
    }
    // Soft sustained step: a small but persistent offset marks the boundary.
    if (difference > SOFT_EDGE_DIFF) {
      if (softStart < 0) softStart = step;
      else if (step - softStart >= SOFT_EDGE_SUSTAIN) return softStart - MARCH_STEP;
    } else {
      softStart = -1;
      distance = step;
    }
  }
  // Marches that never hit an edge are unreliable (probably already on
  // background) — only edge-confirmed stops count.
  return null;
}

/** The line one side should snap to, or null to leave the side alone. */
function snappedLineForSide(image, quad, type) {
  const side = sideOf(quad, type);
  const normal = outwardNormal(quad, side);
  // A side already sitting on a strong real edge must not move — marching
  // outward from it would climb across a merged occluding paper.
  if (sideContrast(image, side.a, side.b) >= STRONG_EDGE_CONTRAST) return null;

  const fractions = sideSampleFractions();
  const reference = paperReferenceAlongSide(image, side, normal, fractions);
  if (reference === null) return null;

  const maxMarch = MAX_MARCH_FRACTION * Math.min(image.width, image.height);
  const stops = [];
  for (const t of fractions) {
    const point = {
      x: side.a.x + (side.b.x - side.a.x) * t,
      y: side.a.y + (side.b.y - side.a.y) * t,
    };
    const marched = marchToEdge(image, { point, normal, reference, maxMarch });
    if (marched === null) continue;
    const distance = Math.max(0, marched);
    stops.push({ x: point.x + normal.nx * distance, y: point.y + normal.ny * distance, d: distance });
  }
  if (stops.length < MIN_MARCH_SAMPLES) return null;

  const distances = stops.map((stop) => stop.d).sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)];
  if (median <= MIN_USEFUL_MARCH) return null;

  const spread = Math.max(STOP_SPREAD_FLOOR, STOP_SPREAD_RATIO * median);
  const usable = stops.filter((stop) => Math.abs(stop.d - median) <= spread);
  if (usable.length < MIN_MARCH_SAMPLES) return null;
  return fitLinePts(usable);
}

/**
 * Direct anti-clip pass: for each side, march outward from sample points while
 * the pixels still match the paper just inside the side. If most points
 * consistently find the real edge further out, the side snaps to a line fitted
 * through those stop points. Works from the pixels, so it recovers document
 * strips that every candidate mask missed.
 */
function snapSidesOutward(image, quad, lockedTypes) {
  const { width, height } = image;
  const originalArea = shoelaceArea(quad);
  const lines = [];
  let moved = false;
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    // Locked seam side (a safe-split cut chord): never march outward across
    // the occluder.
    const snapped = lockedTypes && lockedTypes.has(type)
      ? null
      : snappedLineForSide(image, quad, type);
    if (snapped) { lines.push(snapped); moved = true; }
    else lines.push(lineThrough(side.a, side.b));
  }
  if (!moved) return quad;

  const snappedQuad = quadFromSideLines(lines, width, height);
  if (!snappedQuad) return quad;
  const area = shoelaceArea(snappedQuad);
  // The snap may only GROW the quad, and never explosively.
  if (area < originalArea || area > MAX_SNAP_GROWTH * originalArea ||
      area > MAX_SNAP_IMAGE_COVERAGE * width * height) return quad;
  return snappedQuad;
}

// ------------------------------------------------------------------
// Consensus hull — what the anti-cut net may protect
// ------------------------------------------------------------------

/** Tier 1: a protrusion-verified document part of best's own blob. */
function tier1Clippers(candidates, best, center, bestBox) {
  return candidates
    .filter((candidate) => candidate.safe && !candidate.rejected && candidate !== best &&
      candidate.corners &&
      candidate.score >= CLIPPER_MIN_SCORE_RATIO * best.score &&
      candidate.parentBBox && bboxIoU(candidate.parentBBox, bestBox) >= CLIPPER_MIN_BBOX_IOU &&
      pointInQuad(center, candidate.corners))
    .map((candidate) => ({ q: candidate.corners, tier: 1, mask: candidate.mask }));
}

/**
 * Tier 2: a contributor quad corroborated by a different-mask twin. A lone
 * interior fragment (a below-table-line quad, say) can pass the center and
 * area tests by happenstance; requiring a cross-mask twin blocks it.
 */
function tier2Clippers(contributors, best, center) {
  const pool = (contributors || []).filter((candidate) =>
    candidate !== best && !candidate.split && candidate.corners &&
    candidate.quadArea >= TIER2_MIN_AREA_RATIO * best.quadArea &&
    pointInQuad(center, candidate.corners));
  return pool
    .filter((candidate) => pool.some((other) =>
      other !== candidate && other.mask !== candidate.mask &&
      bboxIoU(bboxOf(other.corners), bboxOf(candidate.corners)) >= TIER2_TWIN_MIN_IOU))
    .map((candidate) => ({ q: candidate.corners, tier: 2, mask: candidate.mask }));
}

/**
 * The region the hull-cut net is allowed to protect: `best.hullPts` clipped
 * down to the DOCUMENT part when other evidence isolates it from a merged
 * neighbour. Without such evidence it returns the hull unchanged (identity),
 * so the net keeps its calibrated behaviour everywhere else.
 */
function consensusHull(corners, options) {
  const { best, candidates, contributors, width, height, info } = options;
  if (!best.hullPts || best.hullPts.length < 3) return best.hullPts;
  const center = centroidOf(corners);
  const bestBox = bboxOf(best.corners);
  const clippers = tier1Clippers(candidates, best, center, bestBox)
    .concat(tier2Clippers(contributors, best, center));

  let points = best.hullPts;
  const originalArea = polygonArea(points);
  const used = [];
  for (const clipper of clippers) {
    const clipped = clipPolyToQuad(points, clipper.q);
    if (clipped.length < 3) continue;
    if (polygonArea(clipped) < MAX_SINGLE_CLIP * polygonArea(points)) continue;
    points = clipped;
    used.push(clipper.tier + ":" + clipper.mask);
  }
  if (polygonArea(points) < MIN_KEPT_AFTER_CLIPPING * originalArea) return best.hullPts;
  if (info) {
    info.keptFrac = originalArea > 0 ? +(polygonArea(points) / originalArea).toFixed(3) : 1;
    info.clippers = used;
  }
  return points;
}
