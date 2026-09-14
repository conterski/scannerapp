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

// The Gaussian blur every gray the detector reads goes through — the legacy
// pipeline's `prepareGray` and the score's `buildFrame` alike.
const BLUR_KERNEL_SIZE = 5;

// The sheet's own colour, read inside a quad and used to tell paper from
// ink, desk and shadow: the legacy sheet-colour mask and the score's palette
// share these calibrated values.
const SHEET_COLOUR = Object.freeze({
  samplesPerAxis: 7,
  inset: 0.1,              // of the quad, clear of its rules
  brightestShare: 0.6,     // the brightest share of samples is paper, not ink
  chromaTolerance: 12,     // Lab a and b, either side of the paper's
  lightnessAllowance: 70,  // Lab L below the paper's that still counts
});

// A side shorter than this has too few samples to judge.
const MIN_PROBE_SIDE_LENGTH = 8;

/** Sample positions along a side, built by accumulation on purpose — see
 *  SIDE_CONTRAST_FRACTIONS. */
function accumulatedFractions(start, end, step) {
  const fractions = [];
  for (let t = start; t <= end; t += step) fractions.push(t);
  return fractions;
}

// Where the band and boundary probes sample along a side: eight points from
// 0.15 to 0.85. This one lands on the count it reads as.
const PROBE_SAMPLE_FRACTIONS = accumulatedFractions(0.15, 0.86, 0.1);

// How far past each endpoint lineContinuesBeyond looks, as a share of the
// extension: five reaches from 0.3 to 1.0.
const CONTINUATION_REACHES = accumulatedFractions(0.3, 1.0, 0.175);

// Where sideContrast samples across a side.
//
// Read as written this is 0.10 to 0.90 in 17 steps, but it is not: accumulating
// 0.05 seventeen times lands on 0.9000000000000002, which fails the bound. The
// probe actually takes 16 samples spanning 0.10 to 0.85, so it leans toward the
// `a` end of every side.
//
// That is now calibration rather than an accident — every threshold in this
// file was tuned against these exact samples — so the accumulation is preserved
// bit for bit and pinned here instead of being corrected into the 17 the
// original loop reads as.
const SIDE_CONTRAST_FRACTIONS = accumulatedFractions(0.1, 0.9, 0.05);

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

// insideLooksLikeDocument: how much of a side must still be standing on the
// document. Correct low-contrast sides measure 0.63-1.00 (receipt1's left and
// right 1.00, ok11 1.00, hard5 0.88, stack2 0.75, fail15 0.63); sides that have
// walked out onto the desk measure 0.00-0.25 (fail1's top 0.25, its left 0.00).
const INSIDE_DOCUMENT_GOOD_RATIO = 0.55;

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

function grayAt(image, x, y) { return image.gray.ucharPtr(y, x)[0]; }

function probeDepthFor(image) {
  return Math.max(MIN_PROBE_DEPTH,
    PROBE_DEPTH_FRACTION * Math.min(image.width, image.height));
}

function median(sortedValues) {
  return sortedValues[Math.floor(sortedValues.length / 2)];
}

function ascending(a, b) { return a - b; }

/** The value `share` (0..1) of the way through an ascending array. */
function percentileOf(sortedValues, share) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * share))];
}

/** The median Lab colour of `colours` ({l, a, b}), channel by channel. */
function medianLab(colours) {
  const channel = (key) => median(colours.map((colour) => colour[key]).sort(ascending));
  return { l: channel("l"), a: channel("a"), b: channel("b") };
}

/** The paper's Lab colour inside `quad`: the median of the brightest share
 *  of a grid of samples, so ink and rulings do not vote. Null when too few
 *  samples fall inside `bounds`.
 *  @param labAt (x, y) => { l, a, b } at integer pixel coordinates */
function paperColourInside(quad, bounds, labAt) {
  const { samplesPerAxis: n, inset, brightestShare } = SHEET_COLOUR;
  const samples = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const point = bilinearInQuad(quad, inset + (1 - 2 * inset) * (i + 0.5) / n, inset + (1 - 2 * inset) * (j + 0.5) / n);
      const x = Math.round(point.x), y = Math.round(point.y);
      if (insideBounds(bounds, x, y)) samples.push(labAt(x, y));
    }
  }
  if (samples.length < n) return null;
  samples.sort((p, q) => q.l - p.l);
  return medianLab(samples.slice(0, Math.max(1, Math.round(samples.length * brightestShare))));
}

/** Gray difference across the line at one point, or null when either side of
 *  the probe falls outside the image.
 *  @param probe { point, normal, depth } */
function crossEdgeStep(image, probe) {
  const { point, normal, depth } = probe;
  const outer = alongNormal(point, normal, depth), inner = alongNormal(point, normal, -depth);
  if (!insideBounds(image, outer.x, outer.y)) return null;
  if (!insideBounds(image, inner.x, inner.y)) return null;
  return grayAt(image, outer.x, outer.y) - grayAt(image, inner.x, inner.y);
}

function unitNormalOf(a, b) {
  const length = segmentLength({ a, b });
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
  for (const t of SIDE_CONTRAST_FRACTIONS) {
    const step = crossEdgeStep(image, { point: pointAlong(a, b, t), normal, depth });
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
    for (const reach of CONTINUATION_REACHES) {
      const point = {
        x: originX + direction * ux * extension * reach,
        y: originY + direction * uy * extension * reach,
      };
      const step = crossEdgeStep(image, { point, normal, depth });
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
  for (const t of PROBE_SAMPLE_FRACTIONS) {
    const innerPoint = pointAlong(inner.a, inner.b, t);
    const outerPoint = pointAlong(outer.a, outer.b, t);

    const toCentroid = Math.hypot(centroid.x - innerPoint.x, centroid.y - innerPoint.y) || 1;
    const referenceX = Math.round(
      innerPoint.x + (centroid.x - innerPoint.x) / toCentroid * INSIDE_REFERENCE_OFFSET);
    const referenceY = Math.round(
      innerPoint.y + (centroid.y - innerPoint.y) / toCentroid * INSIDE_REFERENCE_OFFSET);
    const band = midpointOf({ a: innerPoint, b: outerPoint });
    const bandX = Math.round(band.x), bandY = Math.round(band.y);

    if (!insideBounds(context, bandX, bandY)) continue;
    if (!insideBounds(context, referenceX, referenceY)) continue;
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
      if (insideBounds(image, x, y)) values.push(grayAt(image, x, y));
    }
  }
  if (!values.length) return DEFAULT_INTERIOR_GRAY;
  values.sort(ascending);
  return median(values);
}

/** Majority vote over the three probe depths in one direction from a point.
 *  @param probe { point, direction } */
function majorityAtDepths(image, probe, test) {
  let hits = 0, sampled = 0;
  for (const depth of BOUNDARY_PROBE_DEPTHS) {
    const x = Math.round(probe.point.x + probe.direction.x * depth);
    const y = Math.round(probe.point.y + probe.direction.y * depth);
    if (!insideBounds(image, x, y)) continue;
    sampled++;
    if (test(grayAt(image, x, y))) hits++;
  }
  return sampled >= 2 && hits / sampled > 0.5;
}

/**
 * Walks sample points along `side` and counts, at each one, whether the pixels
 * just INSIDE read like the document interior and whether the pixels just
 * OUTSIDE read like something else. Sampled at three depths per point so
 * sparse text can't imitate background and background can't imitate paper.
 *
 * The two counts are kept apart because they answer different questions. The
 * outside test asks "is this the document's outer boundary", which legitimately
 * fails whenever the background resembles paper; the inside test asks the
 * weaker "is this side still standing on the document at all".
 *
 * @param context { gray, width, height, centroid, interiorRef }
 * @returns { sampled, inside, both } — sample counts, not ratios
 */
function boundarySampleFlags(side, context) {
  const { centroid, interiorRef } = context;
  const { nx, ny } = outwardNormalFrom(side, centroid);

  const isPaper = (value) => Math.abs(value - interiorRef) <= BOUNDARY_INSIDE_TOLERANCE;
  const isNotPaper = (value) => Math.abs(value - interiorRef) > BOUNDARY_OUTSIDE_TOLERANCE;

  let inside = 0, both = 0, sampled = 0;
  for (const t of PROBE_SAMPLE_FRACTIONS) {
    const point = pointAlong(side.a, side.b, t);
    const insideIsPaper = majorityAtDepths(context, { point, direction: { x: -nx, y: -ny } }, isPaper);
    const outsideIsNot = majorityAtDepths(context, { point, direction: { x: nx, y: ny } }, isNotPaper);
    sampled++;
    if (insideIsPaper) inside++;
    if (insideIsPaper && outsideIsNot) both++;
  }
  return { sampled, inside, both };
}

/**
 * True if `side` separates document-looking pixels (inside) from non-document
 * (outside).
 *
 * @param context { gray, width, height, centroid, interiorRef }
 */
function looksLikeDocumentBoundary(side, context) {
  const flags = boundarySampleFlags(side, context);
  return flags.sampled >= MIN_BOUNDARY_SAMPLES &&
    flags.both / flags.sampled >= BOUNDARY_GOOD_RATIO;
}

/**
 * True if the strip just inside `side` still reads like the document — the
 * inside half of the boundary test, without the outside half.
 *
 * This is what the low-contrast fallback needs. That path is taken precisely
 * when the background resembles paper, so the full boundary test is bound to
 * fail there and would veto correct sides (receipt1's left and right measure
 * 1.00 inside but only 0.38 outside). A side standing on the DESK fails the
 * inside half outright (fail1's top 0.25, its left 0.00).
 *
 * @param context { gray, width, height, centroid, interiorRef }
 */
function insideLooksLikeDocument(side, context) {
  const flags = boundarySampleFlags(side, context);
  return flags.sampled >= MIN_BOUNDARY_SAMPLES &&
    flags.inside / flags.sampled >= INSIDE_DOCUMENT_GOOD_RATIO;
}
