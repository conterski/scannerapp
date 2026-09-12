/* worker/grid-evidence.js — the printed table grid as evidence of where the
 * sheet ends.
 *
 * A nota on a carbon-copy pad sits on paper identical to itself: its edge has
 * no luminance step for the masks to find, so the crop runs onto the pad. What
 * exists only on the target sheet is its printed grid. This module finds that
 * grid among the Hough segments, takes its outermost rulings as the printed
 * border, and searches outward from the border for the sheet edge using the
 * signals that do survive paper-on-paper: the thin shadow the top sheet casts
 * onto the pad, the small luminance step across it, and the expected paper
 * margin beyond the printed border. A side found with enough confidence is
 * handed back as a lock, which the fusion pools, the outward snap and the
 * hull-cut net all already honour.
 *
 * Every function here is pure over what it is handed. Every length in GRID is
 * a fraction of the shorter image side unless marked px. The confidence
 * scorer reads only what the fitter recorded, never the fitter's own opinion.
 *
 * Loaded into the worker's global scope by scan-worker.js, after quad-refine.
 */
"use strict";

const GRID = Object.freeze({
  // Stage 1 — finding the grid among the Hough segments.
  familyBandDeg: 25,           // within this of horizontal/vertical joins that family
  inlierToleranceDeg: 2,       // rows: within this of the fitted angle is a ruling
  verticalToleranceDeg: 12,    // columns converge under perspective, so much wider
  minHorizontalLength: 0.25,   // of image WIDTH — the spec's ruling threshold
  minVerticalLength: 0.12,     // of image WIDTH — column separators are shorter
  minHorizontalInliers: 6,     // fewer than this is no grid at all
  // A printed ruling has paper on BOTH sides; the paper's own edge, which is
  // just as long and straight, has paper on one side and the desk on the
  // other. Read this far either side of a segment to tell them apart.
  rulingProbeOffset: 5,        // px
  rulingMaxSideDifference: 35, // gray levels between the two sides
  rulingMinSideGray: 60,       // both sides at least this bright

  // The table's left and right borders are traced by where its rulings END,
  // not by detecting the border lines: those are often lost to the segment
  // cap, while the rulings' endpoints line up along them regardless.
  borderEndShare: 0.3,         // the outermost share of ruling endpoints per side
  borderMinEnds: 3,

  // Stage 2 — the search outward from the printed border for the sheet edge.
  searchDepth: 0.22,           // how far past the border the edge may lie
  marchStep: 2,                // px, the snap's step
  referenceOutset: 4,          // px past the border: blank margin, never print
  rulingClearance: 6,          // px: the border's own ink, never a shadow candidate
  plateauSteps: 5,             // steps of clean paper that must precede a shadow dip
  plateauTolerance: 14,        // gray levels the sheet's own margin may sit below the reference
  plateauAfterSteps: 3,        // steps of pad paper that must follow the shadow's recovery
  padTolerance: 24,            // the pad lies beneath the sheet and reads darker — the
                               // "small, consistently signed step" — so its plateau is looser
  minUsableDepth: 0.03,        // a march cut short before this by a hand has no say
  shadowMinDip: 9,             // gray levels below paper that read as a cast shadow
  shadowMaxWidth: 7,           // px — a shadow line is thin; wider is a real step
  shadowRecovery: 0.6,         // the far side must climb back this share of the dip
  stepWeight: 0.2,             // the sheet is a touch brighter than the pad beneath
  marginPrior: 0.045,          // expected paper margin beyond the printed border
  marginSlack: 0.1,            // margins up to prior+slack cost nothing; beyond, a penalty
  minStopScore: 0.35,          // a sample below this found no edge

  // Stage 3 — what a sample point must not stand on.
  foreignRulingAngleDeg: 12,   // outside both families by this much: another paper's
  foreignRulingRadius: 0.02,   // a march passing within this of one is excluded
  // Skin: the usual YCrCb band, but warm-lit paper sits inside it too, so a
  // pixel must also be clearly darker than the paper and actually saturated.
  skin: { crMin: 133, crMax: 173, cbMin: 77, cbMax: 127, maxLumaOfPaper: 0.85, minSaturation: 0.25 },

  // A cast shadow is a THIN dark line for its whole length. A line of small
  // print dips just like one in a single outward profile, but read across the
  // line it is 8px of ink where a shadow is 2-4px. So the fitted line is
  // re-read along its length, and each point must show a dark run no wider
  // than a shadow. Measured: real shadows run 1-2 steps at nearly every
  // point; the text lines that fooled the profiles run 3-4.
  uniformitySamples: 24,
  uniformityMinUsable: 12,
  uniformityWindow: 6,         // px either side of the line that is read
  shadowRunMinDip: 15,         // a shadow pixel is well below paper; a darker pad is not
  maxShadowRunWidth: 4,        // px of dark across the line that still reads as shadow
  minShadowUniformity: 0.8,    // share of the length that reads as a thin shadow

  // Verdict.
  minStops: 4,
  coverageFloor: 0.4,          // spec: below this the side has no say
  stopSpreadRatio: 0.5,        // agreement: stops within this of the median distance
  maxResidual: 0.008,          // of the short side, for a straight edge
  lockConfidence: 0.6,
});

const DEG = Math.PI / 180;

// ------------------------------------------------------------------
// Stage 1 — the grid
// ------------------------------------------------------------------

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

function angleDifferenceDeg(first, second) {
  const difference = Math.abs(first - second) % 180;
  return Math.min(difference, 180 - difference);
}

/** Length-weighted median angle: the dominant ruling direction of a family. */
function dominantAngle(segments, angleOf) {
  const weighted = segments
    .map((segment) => ({ angle: angleOf(segment), weight: segmentLength(segment) }))
    .sort((a, b) => a.angle - b.angle);
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let accumulated = 0;
  for (const entry of weighted) {
    accumulated += entry.weight;
    if (accumulated >= total / 2) return entry.angle;
  }
  return weighted[weighted.length - 1].angle;
}

/** Gray read a few px to one side of a segment, median over three positions. */
function graySideOf(image, segment, sign) {
  const length = segmentLength(segment) || 1;
  const nx = -(segment.b.y - segment.a.y) / length * sign * GRID.rulingProbeOffset;
  const ny = (segment.b.x - segment.a.x) / length * sign * GRID.rulingProbeOffset;
  const values = [];
  for (const t of [0.25, 0.5, 0.75]) {
    const point = pointAlong(segment.a, segment.b, t);
    const x = Math.round(point.x + nx), y = Math.round(point.y + ny);
    if (isInsideImage(image, x, y)) values.push(grayAt(image, x, y));
  }
  return values.length ? median(values.sort(ascending)) : null;
}

/** Printed ink on paper, as opposed to the paper's own edge against the desk:
 *  both sides read as paper, and read alike. */
function isPrintedRuling(image, segment) {
  const near = graySideOf(image, segment, 1), far = graySideOf(image, segment, -1);
  if (near === null || far === null) return false;
  return Math.min(near, far) >= GRID.rulingMinSideGray &&
    Math.abs(near - far) <= GRID.rulingMaxSideDifference;
}

/** One ruling family: the segments near an orientation, their fitted angle,
 *  and the inliers within tolerance of it that are actually printed. */
function rulingFamily(image, segments, options) {
  const { isMember, angleOf, minLength, tolerance } = options;
  const members = segments.filter((segment) =>
    segmentLength(segment) >= minLength && isMember(angleOf(segment)));
  if (!members.length) return { angle: null, inliers: [] };
  const angle = dominantAngle(members, angleOf);
  const inliers = members.filter((segment) =>
    angleDifferenceDeg(angleOf(segment), angle) <= tolerance &&
    isPrintedRuling(image, segment));
  return { angle, inliers };
}

function midpointOf(segment) {
  return { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
}

/** A segment along the least-squares line through `points`, spanning them. */
function segmentThrough(points) {
  const line = fitLinePts(points);
  const along = points.map((point) => (point.x - line.px) * line.dx + (point.y - line.py) * line.dy);
  const first = Math.min(...along), last = Math.max(...along);
  return {
    a: { x: line.px + line.dx * first, y: line.py + line.dy * first },
    b: { x: line.px + line.dx * last, y: line.py + line.dy * last },
  };
}

/**
 * The table's left and right borders from where its horizontal rulings end.
 * The outermost endpoints belong to the full-width rulings; a fragment's inner
 * end lies further in and never makes the cut.
 */
function bordersFromRulingEnds(inliers) {
  const count = Math.max(GRID.borderMinEnds, Math.round(GRID.borderEndShare * inliers.length));
  if (inliers.length < GRID.borderMinEnds) return { left: null, right: null };
  const leftEnds = inliers.map((s) => (s.a.x <= s.b.x ? s.a : s.b)).sort((p, q) => p.x - q.x);
  const rightEnds = inliers.map((s) => (s.a.x <= s.b.x ? s.b : s.a)).sort((p, q) => q.x - p.x);
  return {
    left: segmentThrough(leftEnds.slice(0, count)),
    right: segmentThrough(rightEnds.slice(0, count)),
  };
}

/** Extends a border to run between two other border lines, so its samples
 *  cover the whole side rather than one ruling's fragment of it. */
function spanBetween(border, first, second) {
  if (!border || !first || !second) return border;
  const line = lineThrough(border.a, border.b);
  const a = lineIntersect(line, lineThrough(first.a, first.b));
  const b = lineIntersect(line, lineThrough(second.a, second.b));
  return a && b ? { a, b } : border;
}

/** The outermost inliers of a family along an axis — the printed border. */
function outermostPair(inliers, coordinate) {
  let lowest = null, highest = null;
  for (const segment of inliers) {
    const value = coordinate(midpointOf(segment));
    if (!lowest || value < coordinate(midpointOf(lowest))) lowest = segment;
    if (!highest || value > coordinate(midpointOf(highest))) highest = segment;
  }
  return { lowest, highest };
}

/**
 * Finds the printed grid among the Hough segments.
 * @param image     { gray, width, height } — read only to tell ink from edges
 * @param segments  [{a, b}] in detection-scale pixels
 * @param bounds    { width, height }
 * @returns { frame, inliers, angles, foreign } or null when there is no grid.
 *          `frame` holds one segment per side type (top, right, bottom, left),
 *          right and left null when the vertical family is too thin;
 *          `foreign` is every long segment pointing neither way — another
 *          paper's rulings.
 */
function findPrintedGrid(image, segments, bounds) {
  const horizontal = rulingFamily(image, segments, {
    isMember: (angle) => Math.abs(angle) <= GRID.familyBandDeg,
    angleOf: segmentAngleDeg,
    minLength: GRID.minHorizontalLength * bounds.width,
    tolerance: GRID.inlierToleranceDeg,
  });
  if (horizontal.inliers.length < GRID.minHorizontalInliers) return null;

  const vertical = rulingFamily(image, segments, {
    isMember: (angle) => Math.abs(angle - 90) <= GRID.familyBandDeg,
    angleOf: verticalAngleDeg,
    minLength: GRID.minVerticalLength * bounds.width,
    tolerance: GRID.verticalToleranceDeg,
  });
  const rows = outermostPair(horizontal.inliers, (point) => point.y);
  const columns = bordersFromRulingEnds(horizontal.inliers);
  const top = spanBetween(rows.lowest, columns.left, columns.right);
  const bottom = spanBetween(rows.highest, columns.left, columns.right);
  const left = spanBetween(columns.left, top, bottom);
  const right = spanBetween(columns.right, top, bottom);

  const isForeign = (segment) =>
    segmentLength(segment) >= GRID.minVerticalLength * bounds.width &&
    angleDifferenceDeg(segmentAngleDeg(segment), horizontal.angle) > GRID.foreignRulingAngleDeg &&
    (vertical.angle === null ||
      angleDifferenceDeg(verticalAngleDeg(segment), vertical.angle) > GRID.foreignRulingAngleDeg);

  return {
    frame: [top, right, bottom, left], // by side type
    inliers: { horizontal: horizontal.inliers.length, vertical: vertical.inliers.length },
    angles: { horizontal: horizontal.angle, vertical: vertical.angle },
    foreign: segments.filter(isForeign),
  };
}

/** Where the grid's interior is: the centre of its horizontal rulings. Used to
 *  orient each border's outward normal. */
function gridCentre(frame) {
  const present = frame.filter(Boolean).map(midpointOf);
  return {
    x: present.reduce((sum, point) => sum + point.x, 0) / present.length,
    y: present.reduce((sum, point) => sum + point.y, 0) / present.length,
  };
}

// ------------------------------------------------------------------
// Stage 3 — exclusions, applied where the search actually samples
// ------------------------------------------------------------------

function rgbAt(image, x, y) {
  const pixel = image.img.ucharPtr(y, x);
  return { r: pixel[0], g: pixel[1], b: pixel[2] };
}

/** ITU-R BT.601, as OpenCV's RGB→YCrCb computes it.
 *  @param paperGray the side's paper reference — skin is darker than it */
function isSkinAt(image, x, y, paperGray) {
  const { r, g, b } = rgbAt(image, x, y);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const { crMin, crMax, cbMin, cbMax, maxLumaOfPaper, minSaturation } = GRID.skin;
  if (luma > maxLumaOfPaper * paperGray) return false;
  const brightest = Math.max(r, g, b);
  if (!brightest || (brightest - Math.min(r, g, b)) / brightest < minSaturation) return false;
  const cr = (r - luma) * 0.713 + 128;
  const cb = (b - luma) * 0.564 + 128;
  return cr >= crMin && cr <= crMax && cb >= cbMin && cb <= cbMax;
}

/** Distance from a point to a segment proper (not its infinite line). */
function distanceToSegment(point, segment) {
  const { a, b } = segment;
  const abx = b.x - a.x, aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1,
    ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * abx), point.y - (a.y + t * aby));
}

function isNearForeignRuling(point, foreign, radius) {
  return foreign.some((segment) => distanceToSegment(point, segment) <= radius);
}

// ------------------------------------------------------------------
// Stage 2 — the edge search along one border's normal
// ------------------------------------------------------------------

/** Gray values outward from `point` along `normal`, one per march step, up to
 *  `depth`. Stops short at the image edge or at an excluded pixel — the values
 *  up to there are still real, so they are kept and the cut is reported. */
function outwardProfile(image, point, normal, depth, exclusions, reference) {
  const values = [];
  for (let distance = 0; distance <= depth; distance += GRID.marchStep) {
    const x = Math.round(point.x + normal.nx * distance);
    const y = Math.round(point.y + normal.ny * distance);
    if (!isInsideImage(image, x, y)) return { values, cutBy: null };
    const excluded = exclusions.isExcluded({ x, y }, reference);
    if (excluded) return { values, cutBy: excluded, at: distance };
    values.push(grayAt(image, x, y));
  }
  return { values, cutBy: null };
}

/**
 * How much a position on the profile looks like the shadow the top sheet casts
 * onto the pad: a narrow dark dip below the paper reference with brightness
 * climbing back on the far side. A drop with no recovery is a real edge onto
 * something dark — that is the masks' job, not this one's.
 */
function shadowScore(values, index, reference) {
  const dip = reference - values[index];
  if (dip < GRID.shadowMinDip) return 0;
  const width = Math.ceil(GRID.shadowMaxWidth / GRID.marchStep);
  let recoveredAt = -1;
  for (let ahead = 1; ahead <= width && index + ahead < values.length; ahead++) {
    if (reference - values[index + ahead] <= dip * (1 - GRID.shadowRecovery)) { recoveredAt = index + ahead; break; }
  }
  if (recoveredAt < 0) return 0;
  // Pad paper beyond the shadow: a dip inside text recovers into more text,
  // not into a clean plateau. The pad may read darker than the sheet.
  for (let after = 0; after < GRID.plateauAfterSteps; after++) {
    const at = recoveredAt + after;
    if (at >= values.length) break;
    if (reference - values[at] > GRID.padTolerance) return 0;
  }
  return Math.min(1, dip / (2 * GRID.shadowMinDip));
}

/** The small, consistently signed step: the sheet on top reads a touch
 *  brighter than the pad beneath it. */
function stepScore(values, index, reference) {
  const beyond = values.slice(index + 1, index + 6);
  if (!beyond.length) return 0;
  const mean = beyond.reduce((sum, value) => sum + value, 0) / beyond.length;
  return reference - mean > 0 ? Math.min(1, (reference - mean) / GRID.shadowMinDip) : 0;
}

/** The expected paper margin beyond the printed border: a penalty on edges
 *  found well past it, never a wall, and never a cost on a tighter margin. */
function priorScore(distance, shortSide) {
  const free = (GRID.marginPrior + GRID.marginSlack) * shortSide;
  if (distance <= free) return 1;
  const overshoot = (distance - free) / (GRID.marginSlack * shortSide);
  return Math.exp(-overshoot * overshoot);
}

/** True when the steps just before `index` read as blank paper — the plateau
 *  a cast shadow has to fall away from. The border's own ink never qualifies. */
function followsPaperPlateau(values, index, reference) {
  if (index < GRID.plateauSteps) return false;
  for (let back = 1; back <= GRID.plateauSteps; back++) {
    if (reference - values[index - back] > GRID.plateauTolerance) return false;
  }
  return true;
}

/**
 * The edge candidate on one profile: the OUTERMOST position that reads as a
 * shadow line between two paper plateaus and scores as plausible. Outermost,
 * not deepest — ink inside the margin's text can dip as far as the shadow
 * does, but nothing on the sheet lies beyond its edge. Null when there is none.
 */
function outermostStopOnProfile(values, reference, shortSide) {
  let stop = null;
  const first = Math.ceil(GRID.rulingClearance / GRID.marchStep);
  for (let index = first; index < values.length - 1; index++) {
    const distance = index * GRID.marchStep;
    if (!followsPaperPlateau(values, index, reference)) continue;
    const shadow = shadowScore(values, index, reference);
    if (!shadow) continue; // no shadow line, no sheet edge: the pad is paper too
    const step = stepScore(values, index, reference);
    const prior = priorScore(distance, shortSide);
    const score = (1 - GRID.stepWeight) * shadow * prior + GRID.stepWeight * step * prior;
    if (score >= GRID.minStopScore) stop = { distance, score, shadow, step, prior };
  }
  return stop;
}

/**
 * Searches outward from one printed border for the sheet edge.
 * @param image     { gray, img, width, height }
 * @param border    the frame segment for this side
 * @param centre    the grid's interior, to orient the outward normal
 * @param exclusions { isExcluded(point, paperGray) → "skin" | "foreign" | null }
 * @returns evidence: { side, stops, coverage, agreement, residual, uniformity,
 *          signals, … } with `side` null when too little was found to fit a
 *          line. The numbers are what scoreSideEvidence reads; nothing here
 *          decides.
 */
function sheetEdgeForBorder(image, border, centre, exclusions) {
  const shortSide = Math.min(image.width, image.height);
  const normal = outwardNormalFrom(border, centre);
  // The blank paper is OUTSIDE the printed border, in the margin; just inside
  // it is the table's own print. paperReferenceAlongSide reads inward of the
  // line it is given, so it gets the border pushed out by the outset plus
  // its own inset.
  const outset = GRID.referenceOutset + PAPER_REFERENCE_INSET;
  const referenceLine = {
    a: { x: border.a.x + normal.nx * outset, y: border.a.y + normal.ny * outset },
    b: { x: border.b.x + normal.nx * outset, y: border.b.y + normal.ny * outset },
  };
  const reference = paperReferenceAlongSide(image,
    { side: referenceLine, normal, fractions: SIDE_SAMPLE_FRACTIONS });
  const evidence = { side: null, stops: [], coverage: 0, agreement: null, residual: null,
                     uniformity: null, reference, excluded: 0, exclusions: { skin: 0, foreign: 0 },
                     distance: null, border, normal,
                     profiles: [],   // one per sample, for the overlay page
                     signals: { shadow: 0, step: 0, prior: 0 } };
  if (reference === null) return evidence;

  const depth = GRID.searchDepth * shortSide;
  const usableDepth = GRID.minUsableDepth * shortSide;
  let usable = 0;
  for (const t of SIDE_SAMPLE_FRACTIONS) {
    const point = pointAlong(border.a, border.b, t);
    const profile = outwardProfile(image, point, normal, depth, exclusions, reference);
    // A hand or another paper across the march before it reached a usable
    // depth: this sample has no say. Cut later than that, the values it did
    // read are still evidence.
    if (profile.cutBy && profile.at < usableDepth) {
      evidence.excluded++;
      evidence.exclusions[profile.cutBy]++;
      continue;
    }
    usable++;
    const stop = outermostStopOnProfile(profile.values, reference, shortSide);
    evidence.profiles.push({ t, point, values: profile.values, cutBy: profile.cutBy,
                             stop: stop ? stop.distance : null });
    if (stop) {
      evidence.stops.push(Object.assign({
        x: point.x + normal.nx * stop.distance,
        y: point.y + normal.ny * stop.distance,
      }, stop));
    }
  }
  evidence.coverage = usable / SIDE_SAMPLE_FRACTIONS.length;
  if (evidence.stops.length < GRID.minStops) return evidence;

  const distances = evidence.stops.map((stop) => stop.distance).sort(ascending);
  const medianDistance = median(distances);
  evidence.distance = medianDistance / shortSide;
  const spread = Math.max(GRID.marchStep * 2, GRID.stopSpreadRatio * medianDistance);
  const agreeing = evidence.stops.filter((stop) => Math.abs(stop.distance - medianDistance) <= spread);
  evidence.agreement = agreeing.length / evidence.stops.length;
  if (agreeing.length < GRID.minStops) return evidence;

  const line = fitLinePts(agreeing);
  evidence.residual = Math.max(...agreeing.map((stop) =>
    Math.abs((stop.x - line.px) * line.dy - (stop.y - line.py) * line.dx))) / shortSide;
  for (const key of Object.keys(evidence.signals)) {
    evidence.signals[key] = agreeing.reduce((sum, stop) => sum + stop[key], 0) / agreeing.length;
  }
  // The side is the fitted line, spanning the border's own extent.
  const half = segmentLength(border) / 2;
  evidence.side = {
    a: { x: line.px - line.dx * half, y: line.py - line.dy * half },
    b: { x: line.px + line.dx * half, y: line.py + line.dy * half },
  };
  evidence.uniformity = shadowUniformity(image, spanOfStops(line, agreeing), normal, reference, exclusions);
  return evidence;
}

/** The stretch of the fitted line the agreeing stops actually cover. Beyond
 *  it the line is extrapolation, and a thin shadow is not owed there. */
function spanOfStops(line, stops) {
  const along = stops.map((stop) => (stop.x - line.px) * line.dx + (stop.y - line.py) * line.dy);
  const first = Math.min(...along), last = Math.max(...along);
  return {
    a: { x: line.px + line.dx * first, y: line.py + line.dy * first },
    b: { x: line.px + line.dx * last, y: line.py + line.dy * last },
  };
}

/** How many pixels across the line are dark at `point`, read through a
 *  window either side of it. A shadow is a thin run; ink is a wide one. */
function darkRunAcross(image, point, normal, reference) {
  let run = 0;
  for (let offset = -GRID.uniformityWindow; offset <= GRID.uniformityWindow; offset += GRID.marchStep) {
    const x = Math.round(point.x + normal.nx * offset), y = Math.round(point.y + normal.ny * offset);
    if (!isInsideImage(image, x, y)) continue;
    if (reference - grayAt(image, x, y) >= GRID.shadowRunMinDip) run += GRID.marchStep;
  }
  return run;
}

/**
 * How much of the fitted line reads as a thin shadow, re-sampled along the
 * stretch the stops cover. Excluded points (a hand, another paper) are left
 * out of the count; with too few usable points the answer is null and the
 * side cannot lock.
 */
function shadowUniformity(image, span, normal, reference, exclusions) {
  let usable = 0, thinAndDark = 0;
  for (let i = 0; i < GRID.uniformitySamples; i++) {
    const point = pointAlong(span.a, span.b, (i + 0.5) / GRID.uniformitySamples);
    const x = Math.round(point.x), y = Math.round(point.y);
    if (!isInsideImage(image, x, y) || exclusions.isExcluded({ x, y }, reference)) continue;
    usable++;
    const run = darkRunAcross(image, point, normal, reference);
    if (run > 0 && run <= GRID.maxShadowRunWidth) thinAndDark++;
  }
  return usable >= GRID.uniformityMinUsable ? thinAndDark / usable : null;
}

// ------------------------------------------------------------------
// The verdict — written so the fitter cannot influence it
// ------------------------------------------------------------------

/**
 * Confidence 0..1 that `evidence` places a real sheet edge. Reads only what the
 * search recorded: coverage, how many stops agreed with each other, how
 * straight they are, and how strong the signals were at those stops.
 */
function scoreSideEvidence(evidence) {
  if (!evidence.side) return 0;
  if (evidence.coverage < GRID.coverageFloor) return 0;
  if (evidence.uniformity === null || evidence.uniformity < GRID.minShadowUniformity) return 0;
  const straightness = Math.max(0, 1 - evidence.residual / GRID.maxResidual);
  const strength = (1 - GRID.stepWeight) * evidence.signals.shadow +
                   GRID.stepWeight * evidence.signals.step;
  // The prior already chose which stop each sample kept; here it only marks
  // down a side that sits well past any plausible margin.
  return Math.min(1, strength * evidence.agreement * straightness * Math.sqrt(evidence.signals.prior));
}

/**
 * Every side the printed grid can vouch for, as lock candidates.
 * @param image   { gray, img, width, height }
 * @param grid    from findPrintedGrid
 * @returns [{ type, side, confidence, evidence }] for each side that has a
 *          printed border, whether or not it reaches lockConfidence — the
 *          caller decides what to lock; the trace wants all of them.
 */
function gridSideEvidence(image, grid) {
  const centre = gridCentre(grid.frame);
  const radius = GRID.foreignRulingRadius * Math.min(image.width, image.height);
  const exclusions = {
    isExcluded: (point, paperGray) => {
      if (isSkinAt(image, point.x, point.y, paperGray)) return "skin";
      if (isNearForeignRuling(point, grid.foreign, radius)) return "foreign";
      return null;
    },
  };
  const results = [];
  grid.frame.forEach((border, type) => {
    if (!border) return;
    const evidence = sheetEdgeForBorder(image, border, centre, exclusions);
    results.push({ type, side: evidence.side, confidence: scoreSideEvidence(evidence), evidence });
  });
  return results;
}
