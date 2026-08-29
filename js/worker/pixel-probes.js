/* worker/pixel-probes.js — the questions the detector asks the actual pixels.
 *
 * Every function here reads the blurred grayscale Mat and answers one yes/no
 * or 0..1 question about a candidate side. They are what separate a real paper
 * edge from a printed table border, a shadow line or a desk edge, so their
 * thresholds are calibration: changing a number here moves crops on the whole
 * test set. Each constant records what it was tuned against.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

// A side shorter than this has too few samples to judge.
const MIN_PROBE_SIDE_LENGTH = 8;

// How far to either side of a line we sample for the cross-edge step.
const PROBE_DEPTH_FRACTION = 0.012;
const MIN_PROBE_DEPTH = 6;

// A gray step of this many levels counts as full contrast (1.0).
const CONTRAST_FULL_SCALE = 25;
const MIN_CONTRAST_SAMPLES = 5;

// lineContinuesBeyond: how far past each endpoint to look, and how strong the
// step has to stay out there to call the line a shadow/desk edge.
const CONTINUATION_EXTENSION_FRACTION = 0.25;
const CONTINUATION_CONTRAST = 0.4;

// bandMatchesInside: the paper reference is taken this far inward, and a
// sample counts as "still document" within this many gray levels of it.
const INSIDE_REFERENCE_OFFSET = 12;
const BAND_MATCH_TOLERANCE = 35;
const MIN_BAND_SAMPLES = 4;
const BAND_MATCH_RATIO = 0.6;

// looksLikeDocumentBoundary: probe depths on each side of the line, and how
// close to / far from the interior reference each side has to read.
const BOUNDARY_PROBE_DEPTHS = [12, 22, 32];
const BOUNDARY_INSIDE_TOLERANCE = 35;
const BOUNDARY_OUTSIDE_TOLERANCE = 30;
const MIN_BOUNDARY_SAMPLES = 5;
const BOUNDARY_GOOD_RATIO = 0.55;

// The interior reference is the median of a grid this far around the centroid.
const INTERIOR_GRID_RADIUS = 2;
const INTERIOR_GRID_STEP_FRACTION = 0.04;
const DEFAULT_INTERIOR_GRAY = 128;

// ------------------------------------------------------------------
// Sampling helpers
// ------------------------------------------------------------------

/* Every probe takes an `image`: { gray, width, height }. The edge-fusion
 * context and the detect pipeline both already have that shape, so they can be
 * handed straight in. */

function isInsideImage(image, x, y) {
  return x >= 0 && y >= 0 && x < image.width && y < image.height;
}

function grayAt(image, x, y) { return image.gray.ucharPtr(y, x)[0]; }

function probeDepthFor(image) {
  return Math.max(MIN_PROBE_DEPTH,
    PROBE_DEPTH_FRACTION * Math.min(image.width, image.height));
}

function median(sortedValues) {
  return sortedValues[Math.floor(sortedValues.length / 2)];
}

function ascending(a, b) { return a - b; }

/** Gray difference across the line at one point, or null when either probe
 *  falls outside the image. */
function crossEdgeStep(image, point, normal, depth) {
  const x1 = Math.round(point.x + normal.nx * depth);
  const y1 = Math.round(point.y + normal.ny * depth);
  const x2 = Math.round(point.x - normal.nx * depth);
  const y2 = Math.round(point.y - normal.ny * depth);
  if (!isInsideImage(image, x1, y1)) return null;
  if (!isInsideImage(image, x2, y2)) return null;
  return grayAt(image, x1, y1) - grayAt(image, x2, y2);
}

function unitNormalOf(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return { length, nx: -(b.y - a.y) / length, ny: (b.x - a.x) / length };
}

// ------------------------------------------------------------------
// The probes
// ------------------------------------------------------------------

/**
 * How strongly the image changes across this line (0..1). A real paper edge
 * has paper on one side and background on the other; a line printed INSIDE
 * the document (a table border) has paper on both sides and scores ~0.
 *
 * The median of SIGNED differences is what makes that work: a real edge is a
 * consistent one-direction step, while printed lines surrounded by text
 * produce noisy both-way diffs whose median collapses toward zero.
 */
function sideContrast(image, a, b) {
  const { length, nx, ny } = unitNormalOf(a, b);
  if (length < MIN_PROBE_SIDE_LENGTH) return 0;
  const depth = probeDepthFor(image);
  const normal = { nx, ny };
  const steps = [];
  for (let t = 0.1; t <= 0.9; t += 0.05) {
    const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const step = crossEdgeStep(image, point, normal, depth);
    if (step !== null) steps.push(step);
  }
  if (steps.length < MIN_CONTRAST_SAMPLES) return 0;
  steps.sort(ascending);
  return Math.min(1, Math.abs(median(steps)) / CONTRAST_FULL_SCALE);
}

/**
 * True if this line's contrast step CONTINUES past both endpoints — a shadow
 * boundary or desk edge crosses the whole scene, while a real paper edge
 * stops at the document corners.
 */
function lineContinuesBeyond(image, a, b) {
  const { length, nx, ny } = unitNormalOf(a, b);
  if (length < MIN_PROBE_SIDE_LENGTH) return false;
  const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
  const depth = probeDepthFor(image);
  const normal = { nx, ny };
  const extension = CONTINUATION_EXTENSION_FRACTION * length;

  const steps = [];
  for (const [originX, originY, direction] of [[a.x, a.y, -1], [b.x, b.y, 1]]) {
    for (let reach = 0.3; reach <= 1.0; reach += 0.175) {
      const point = {
        x: originX + direction * ux * extension * reach,
        y: originY + direction * uy * extension * reach,
      };
      const step = crossEdgeStep(image, point, normal, depth);
      if (step !== null) steps.push(step);
    }
  }
  if (steps.length < MIN_CONTRAST_SAMPLES) return false;
  steps.sort(ascending);
  return Math.abs(median(steps)) / CONTRAST_FULL_SCALE >= CONTINUATION_CONTRAST;
}

/**
 * True if the strip between two competing sides still looks like document.
 * Each band sample is compared to the pixel just INSIDE the inner side at the
 * same position (a local paper reference), so brightness gradients and dark
 * artwork on the paper don't break the comparison.
 */
function bandMatchesInside(context, inner, outer) {
  const { centroid } = context;
  let matched = 0, sampled = 0;
  for (let t = 0.15; t <= 0.86; t += 0.1) {
    const innerX = inner.a.x + (inner.b.x - inner.a.x) * t;
    const innerY = inner.a.y + (inner.b.y - inner.a.y) * t;
    const outerX = outer.a.x + (outer.b.x - outer.a.x) * t;
    const outerY = outer.a.y + (outer.b.y - outer.a.y) * t;

    const toCentroid = Math.hypot(centroid.x - innerX, centroid.y - innerY) || 1;
    const referenceX = Math.round(innerX + (centroid.x - innerX) / toCentroid * INSIDE_REFERENCE_OFFSET);
    const referenceY = Math.round(innerY + (centroid.y - innerY) / toCentroid * INSIDE_REFERENCE_OFFSET);
    const bandX = Math.round((innerX + outerX) / 2);
    const bandY = Math.round((innerY + outerY) / 2);

    if (!isInsideImage(context, bandX, bandY)) continue;
    if (!isInsideImage(context, referenceX, referenceY)) continue;
    sampled++;
    if (Math.abs(grayAt(context, bandX, bandY) - grayAt(context, referenceX, referenceY))
        <= BAND_MATCH_TOLERANCE) {
      matched++;
    }
  }
  return sampled >= MIN_BAND_SAMPLES && matched / sampled >= BAND_MATCH_RATIO;
}

/** Median gray of the document's central region — the "this is paper" value
 *  the boundary test compares against. */
function interiorGrayReference(image, centroid) {
  const values = [];
  for (let dy = -INTERIOR_GRID_RADIUS; dy <= INTERIOR_GRID_RADIUS; dy++) {
    for (let dx = -INTERIOR_GRID_RADIUS; dx <= INTERIOR_GRID_RADIUS; dx++) {
      const x = Math.round(centroid.x + dx * INTERIOR_GRID_STEP_FRACTION * image.width);
      const y = Math.round(centroid.y + dy * INTERIOR_GRID_STEP_FRACTION * image.height);
      if (isInsideImage(image, x, y)) values.push(grayAt(image, x, y));
    }
  }
  if (!values.length) return DEFAULT_INTERIOR_GRAY;
  values.sort(ascending);
  return median(values);
}

/** Majority vote over the three probe depths in one direction from a point. */
function majorityAtDepths(image, point, direction, test) {
  let hits = 0, sampled = 0;
  for (const depth of BOUNDARY_PROBE_DEPTHS) {
    const x = Math.round(point.x + direction.x * depth);
    const y = Math.round(point.y + direction.y * depth);
    if (!isInsideImage(image, x, y)) continue;
    sampled++;
    if (test(grayAt(image, x, y))) hits++;
  }
  return sampled >= 2 && hits / sampled > 0.5;
}

/**
 * True if `side` separates document-looking pixels (inside) from
 * non-document (outside). Sampled at three depths per point so sparse text
 * can't imitate background and background can't imitate paper.
 *
 * @param context { gray, width, height, centroid, interiorRef }
 */
function looksLikeDocumentBoundary(side, context) {
  const { centroid, interiorRef } = context;
  const { length } = unitNormalOf(side.a, side.b);
  let nx = -(side.b.y - side.a.y) / (length || 1);
  let ny = (side.b.x - side.a.x) / (length || 1);
  const midX = (side.a.x + side.b.x) / 2;
  const midY = (side.a.y + side.b.y) / 2;
  if (nx * (centroid.x - midX) + ny * (centroid.y - midY) > 0) { nx = -nx; ny = -ny; }

  const isPaper = (value) => Math.abs(value - interiorRef) <= BOUNDARY_INSIDE_TOLERANCE;
  const isNotPaper = (value) => Math.abs(value - interiorRef) > BOUNDARY_OUTSIDE_TOLERANCE;

  let good = 0, sampled = 0;
  for (let t = 0.15; t <= 0.86; t += 0.1) {
    const point = {
      x: side.a.x + (side.b.x - side.a.x) * t,
      y: side.a.y + (side.b.y - side.a.y) * t,
    };
    const insideIsPaper = majorityAtDepths(context, point, { x: -nx, y: -ny }, isPaper);
    const outsideIsNot = majorityAtDepths(context, point, { x: nx, y: ny }, isNotPaper);
    sampled++;
    if (insideIsPaper && outsideIsNot) good++;
  }
  return sampled >= MIN_BOUNDARY_SAMPLES && good / sampled >= BOUNDARY_GOOD_RATIO;
}
