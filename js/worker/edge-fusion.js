/* worker/edge-fusion.js — building the document quad from the best individual
 * EDGES rather than from any single candidate.
 *
 * A rectangle PRINTED ON the document (a table, a stamp box) can outscore the
 * paper itself, and threshold blobs can overshoot into the background. Fusion
 * takes each side independently: gather every contributor's version of that
 * side, keep the ones showing real cross-edge contrast, and prefer the
 * outermost of those — then intersect the four winners.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

// Which candidates get a vote. Too low and interior fragments join the pools.
const CONTRIBUTOR_MIN_SCORE_RATIO = 0.25;
const CONTRIBUTOR_MIN_BBOX_IOU = 0.45;

// The per-side contrast gate floats with the best side available, so a
// soft-but-real edge stays in play when nothing stronger exists.
const CONTRAST_GATE_FLOOR = 0.35;
const CONTRAST_GATE_CEILING = 0.5;
const CONTRAST_GATE_RATIO = 0.6;

// Below this there is no edge to speak of, so the continues-beyond veto is
// not even worth evaluating.
const VETO_MIN_CONTRAST = 0.15;

// How far inward of best's own side a candidate may sit before it has to
// prove it looks like a document boundary.
const INWARD_TOLERANCE_FRACTION = 0.01;
const MIN_INWARD_TOLERANCE = 8;

// Fallback chain thresholds.
const BOUNDARY_FALLBACK_MIN_CONTRAST = 0.35;
const BEST_FALLBACK_MIN_CONTRAST = 0.35;
const LOW_CONTRAST_WALK_MIN = 0.15;

// Sides closer together than this are the same edge; step out without asking.
const SAME_EDGE_GAP = 8;

// Hough segments extend a side outward only, and only this far.
const HOUGH_APPLIES_BELOW_CONTRAST = 0.6;
const HOUGH_MIN_CONTRAST = 0.35;
const HOUGH_MAX_REACH_FRACTION = 0.2;
const HOUGH_ANGLE_TOLERANCE_DEG = 25;

// A fused quad outside this area range is not a document.
const FUSED_MIN_AREA_FRACTION = 0.05;
const FUSED_MAX_AREA_FRACTION = 1.02;

// ------------------------------------------------------------------
// Contributors and side options
// ------------------------------------------------------------------

/** Split parts (other than a winning one) are excluded: their cut chords are
 *  interior lines that would poison the side pools. */
function collectContributors(candidates, best) {
  const bestBox = bboxOf(best.corners);
  return candidates.filter((candidate) =>
    !candidate.rejected &&
    (candidate === best || !candidate.split) &&
    candidate.score >= CONTRIBUTOR_MIN_SCORE_RATIO * best.score &&
    bboxIoU(bboxOf(candidate.corners), bestBox) >= CONTRIBUTOR_MIN_BBOX_IOU);
}

function sideOptionFrom(side, type, context, extra) {
  return Object.assign({
    s: side,
    contrast: sideContrast(context, side.a, side.b),
    outward: sideOutwardness(side, type),
  }, extra);
}

function buildSideOptions(contributors, type, best, context) {
  return contributors.map((candidate) =>
    sideOptionFrom(sideOf(candidate.corners, type), type, context,
      { isBest: candidate === best }));
}

/** A locked side (the cut chord of a winning safe split, or a reunited
 *  section's seam) is the doc/occluder boundary: no pool, no outward walk,
 *  no Hough extension. */
function lockedSideChoice(best, type, context) {
  const side = sideOf(best.corners, type);
  return sideOptionFrom(side, type, context, { locked: true });
}

// ------------------------------------------------------------------
// Choosing one side
// ------------------------------------------------------------------

/**
 * Walks outward, extending only while the strip between sides still looks like
 * the document. NEVER extends past a side already sitting on a strong real
 * edge — strong edges ARE the document boundary.
 */
function walkOutward(pick, options, context) {
  let chosen = pick;
  for (const next of options) {
    if (next.outward <= chosen.outward) continue;
    if (next.outward - chosen.outward < SAME_EDGE_GAP ||
        bandMatchesInside(context, chosen.s, next.s)) {
      chosen = next;
    }
  }
  return chosen;
}

/** Hough segments aligned to a direction, gated by contrast and the
 *  continues-beyond veto. */
function houghSideOptions(type, referenceDirection, context) {
  const options = [];
  const tolerance = (HOUGH_ANGLE_TOLERANCE_DEG * Math.PI) / 180;
  for (const segment of context.segments || []) {
    const segmentDirection = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x);
    if (angleBetweenDirections(segmentDirection, referenceDirection) > tolerance) continue;
    const contrast = sideContrast(context, segment.a, segment.b);
    if (contrast < HOUGH_MIN_CONTRAST) continue;
    if (lineContinuesBeyond(context, segment.a, segment.b)) continue;
    options.push({ s: segment, contrast, outward: sideOutwardness(segment, type), continues: false });
  }
  return options;
}

function contrastGateFor(options) {
  const strongest = options.reduce((max, option) => Math.max(max, option.contrast), 0);
  return Math.max(CONTRAST_GATE_FLOOR,
    Math.min(CONTRAST_GATE_CEILING, CONTRAST_GATE_RATIO * strongest));
}

/**
 * An interior printed line (a banner, a table border, a handwriting baseline)
 * can pass the contrast gate when the true edge is vetoed as continuing into
 * an ADJACENT PAPER. A side moving INWARD of best's own side must therefore
 * also look like a document boundary — interior lines have paper on both
 * sides and fail.
 */
function eligibleSideOptions(options, bestOption, context) {
  const tolerance = Math.max(MIN_INWARD_TOLERANCE,
    INWARD_TOLERANCE_FRACTION * Math.min(context.width, context.height));
  const gate = contrastGateFor(options);
  return options
    .filter((option) => option.contrast >= gate && !option.continues &&
      (option.outward >= bestOption.outward - tolerance || isBoundaryLike(option, context)))
    .sort((a, b) => a.outward - b.outward);
}

/** Memoized per option — the boundary probe is the expensive one. */
function isBoundaryLike(option, context) {
  if (option.bLike === undefined) option.bLike = looksLikeDocumentBoundary(option.s, context);
  return option.bLike;
}

/**
 * When nothing passes the strict gate, fall back in a fixed order. Returns
 * {pick, rule, eligible} — `eligible` is the pool the outward walk may use.
 */
function fallbackSideChoice(options, bestOption, context) {
  // Outermost boundary-verified side with real edge evidence: a true edge
  // vetoed only because its step continues into a neighbouring object. The
  // veto is bypassed — an overshoot shadow line fails the inside-check and
  // stays out.
  const boundaryVerified = options
    .filter((option) => option.contrast >= BOUNDARY_FALLBACK_MIN_CONTRAST &&
      isBoundaryLike(option, context))
    .sort((a, b) => a.outward - b.outward);
  if (boundaryVerified.length) {
    return { pick: boundaryVerified[boundaryVerified.length - 1], rule: "blike", eligible: [] };
  }

  // The veto killed a genuinely contrasty best side — best's own boundary is
  // the safest anti-cut default, taken verbatim (no walk, no Hough).
  // Bland-background overshoot has ~0 contrast and routes to "lowc" instead.
  if (bestOption.continues && bestOption.contrast >= BEST_FALLBACK_MIN_CONTRAST) {
    return { pick: bestOption, rule: "bestfb", eligible: [] };
  }

  // Low-contrast scene (white paper on a white floor): start from the
  // strongest side, but still walk outward over sides with at least weak edge
  // evidence, so a printed form border cannot win outright.
  const nonContinuing = options.filter((option) => !option.continues);
  const pool = nonContinuing.length ? nonContinuing : options;
  const strongest = pool.reduce((a, b) => (b.contrast > a.contrast ? b : a));
  const eligible = pool
    .filter((option) => option.contrast >= LOW_CONTRAST_WALK_MIN &&
      option.outward >= strongest.outward)
    .sort((a, b) => a.outward - b.outward);
  return { pick: strongest, rule: "lowc", eligible };
}

function extendWithHoughSegments(pick, type, context) {
  if (!context.segments || !context.segments.length) return { pick, houghExt: false };
  if (pick.contrast >= HOUGH_APPLIES_BELOW_CONTRAST) return { pick, houghExt: false };

  const reference = Math.atan2(pick.s.b.y - pick.s.a.y, pick.s.b.x - pick.s.a.x);
  const maxReach = HOUGH_MAX_REACH_FRACTION * Math.min(context.width, context.height);
  const extras = houghSideOptions(type, reference, context)
    .filter((option) => option.outward > pick.outward &&
      option.outward - pick.outward <= maxReach)
    .sort((a, b) => a.outward - b.outward);

  const extended = walkOutward(pick, extras, context);
  return { pick: extended, houghExt: extended !== pick };
}

/** Shadow boundaries and desk edges continue past the document corners; real
 *  paper edges don't. Veto the continuers. */
function markContinuingSides(options, context) {
  for (const option of options) {
    option.continues = option.contrast >= VETO_MIN_CONTRAST &&
      lineContinuesBeyond(context, option.s.a, option.s.b);
  }
}

function chooseSideForType(contributors, best, type, context) {
  const options = buildSideOptions(contributors, type, best, context);
  markContinuingSides(options, context);
  const bestOption = options.find((option) => option.isBest);

  let eligible = eligibleSideOptions(options, bestOption, context);
  let pick = eligible[0];
  let rule = "strict";
  if (!eligible.length) {
    const fallback = fallbackSideChoice(options, bestOption, context);
    pick = fallback.pick;
    rule = fallback.rule;
    eligible = fallback.eligible;
  }

  const walkFrom = pick.outward;
  let houghExt = false;
  if (rule !== "bestfb") {
    pick = walkOutward(pick, eligible, context);
    const extension = extendWithHoughSegments(pick, type, context);
    pick = extension.pick;
    houghExt = extension.houghExt;
  }

  pick.rule = rule;
  pick.bestOutward = bestOption.outward;
  pick.vetoedBest = !!bestOption.continues;
  pick.walkFrom = walkFrom;
  pick.houghExt = houghExt;
  return pick;
}

// ------------------------------------------------------------------
// Assembly
// ------------------------------------------------------------------

function recordFusionTrace(trace, chosen) {
  for (let type = 0; type < SIDE_COUNT; type++) {
    const pick = chosen[type];
    trace.push({
      type, contrast: +pick.contrast.toFixed(2), outward: Math.round(pick.outward),
      locked: !!pick.locked, rule: pick.locked ? "locked" : pick.rule,
      bLike: pick.bLike, vetoedBest: !!pick.vetoedBest,
      bestOutward: pick.bestOutward !== undefined ? Math.round(pick.bestOutward) : undefined,
      walkFrom: pick.walkFrom !== undefined ? Math.round(pick.walkFrom) : undefined,
      houghExt: !!pick.houghExt,
      a: { x: Math.round(pick.s.a.x), y: Math.round(pick.s.a.y) },
      b: { x: Math.round(pick.s.b.x), y: Math.round(pick.s.b.y) },
    });
  }
}

function quadFromChosenSides(chosen, width, height) {
  const lines = chosen.map((pick) => lineThrough(pick.s.a, pick.s.b));
  const quad = quadFromSideLines(lines, width, height);
  if (!quad) return null;
  const areaFraction = shoelaceArea(quad) / (width * height);
  if (areaFraction < FUSED_MIN_AREA_FRACTION ||
      areaFraction > FUSED_MAX_AREA_FRACTION) return null;
  return quad;
}

/**
 * Fuses the four document edges from across candidates.
 * @param options { gray, width, height, segments, trace, lockedTypes, meta } —
 *                `meta` is an out-param receiving `contributors` and `rules`
 */
function fuseQuad(candidates, best, options) {
  const { gray, width, height, segments, trace, lockedTypes, meta } = options;
  const contributors = collectContributors(candidates, best);
  if (!contributors.length) return null;
  if (meta) meta.contributors = contributors;

  const centroid = centroidOf(best.corners);
  const context = {
    gray, width, height, segments, centroid,
    interiorRef: interiorGrayReference({ gray, width, height }, centroid),
  };

  const chosen = [];
  for (let type = 0; type < SIDE_COUNT; type++) {
    chosen.push(lockedTypes && lockedTypes.has(type)
      ? lockedSideChoice(best, type, context)
      : chooseSideForType(contributors, best, type, context));
  }

  if (meta) meta.rules = chosen.map((pick) => (pick.locked ? "locked" : pick.rule));
  if (trace) recordFusionTrace(trace, chosen);

  return quadFromChosenSides(chosen, width, height);
}
