/* worker/candidates.js — turning a binary mask into scored document candidates.
 *
 * Each mask contributes its largest outer contours; every contour becomes a
 * convex hull, a quad fitted to that hull, and a score saying how document-like
 * the quad is. A deeply notched blob is additionally "declumped" — cut at its
 * two deepest convexity defects — because that is what a document merged with
 * an occluding paper looks like.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

// quadFromHull: loosen the approxPolyDP epsilon until only 4 vertices remain.
const APPROX_EPSILON_START = 0.02;
const APPROX_EPSILON_LIMIT = 0.121;
const APPROX_EPSILON_STEP = 0.01;

// pentagonToQuad: a reconstruction with a squashed corner is not a document.
const PENTAGON_MIN_ANGLE_DEG = 35;
const PENTAGON_MAX_ANGLE_DEG = 145;
const PENTAGON_PARALLELISM_TOLERANCE_DEG = 30;
const PENTAGON_AREA_WEIGHT = 0.25;       // area counts this much on its own…
const PENTAGON_PARALLEL_WEIGHT = 0.75;   // …and this much times parallelism

// quadMetrics: what makes a quad look like a document.
const BORDER_MARGIN_FRACTION = 0.02;     // corners this close to the frame are suspect
const MIN_QUAD_AREA_FRACTION = 0.05;
const MAX_QUAD_AREA_FRACTION = 0.98;
const SOLIDITY_EXPONENT = 1.5;           // merged L-shaped blobs fall away fast
const AREA_SCORE_BASE = 0.6;
const AREA_SCORE_WEIGHT = 0.4;
const BORDER_PENALTY_PER_CORNER = 0.2;

// candidateFromPoints
const MIN_POINTS_FOR_HULL = 8;
const CONTOUR_AREA_FLOOR_OF_HULL = 0.8;
// A declumped part should beat a genuinely bad merged quad but not a decent
// one. Lifted to 1.0 once the part is proven safe (see splitCandidates).
const SPLIT_SCORE_PENALTY = 0.85;

// splitCandidates: the declumping gate and the two safe-split paths.
const DEEP_DEFECT_DEPTH_FRACTION = 0.08;
const SPLIT_MAX_SOLIDITY = 0.88;
const SPLIT_MAX_OWN_SCORE = 0.55;
const MIN_CUT_INDEX_SEPARATION = 4;
const MIN_PART_AREA_SHARE = 0.15;
const STRONG_MUTUAL_PROTRUSION = 0.6;    // true stacks measure >= 0.64
const MODERATE_MUTUAL_PROTRUSION = 0.5;  // fail15's slip-on-note measures 0.56
const MIN_CHORD_CONTRAST = 0.3;          // fail15 chord 0.52; a fold/notch <= 0.08
const MAX_SELF_OUTSIDE = 0.03;

// candidatesFromMask
const MAX_CONTOURS_PER_MASK = 5;
const MIN_CONTOUR_AREA_FRACTION = 0.04;

// ------------------------------------------------------------------
// Hull → quad
// ------------------------------------------------------------------

function hullPoints(hull) {
  const points = [];
  for (let i = 0; i < hull.rows; i++) {
    points.push({ x: hull.data32S[i * 2], y: hull.data32S[i * 2 + 1] });
  }
  return points;
}

function directionOf(from, to) { return Math.atan2(to.y - from.y, to.x - from.x); }

function angleBetweenDirections(first, second) {
  const difference = Math.abs(first - second) % Math.PI;
  return Math.min(difference, Math.PI - difference);
}

/** 1 when both pairs of opposite sides are parallel, falling to 0 at the
 *  tolerance. */
function parallelismOf(quad) {
  const skew = angleBetweenDirections(directionOf(quad.tl, quad.tr), directionOf(quad.bl, quad.br)) +
               angleBetweenDirections(directionOf(quad.tl, quad.bl), directionOf(quad.tr, quad.br));
  return Math.max(0, 1 - skew / (PENTAGON_PARALLELISM_TOLERANCE_DEG * Math.PI / 180));
}

/**
 * A pentagon is usually a document with one corner truncated (occluded by
 * another paper). Reconstruct the quad: drop one side and extend its two
 * neighbours to their intersection. The right drop yields a clean
 * near-parallelogram, so reconstructions are scored by area × parallelism.
 */
function pentagonToQuad(points) {
  let best = null, bestScore = 0;
  for (let dropped = 0; dropped < 5; dropped++) {
    // Side dropped: points[dropped] → points[dropped+1]. Extend its neighbours.
    const previousSide = lineThrough(points[(dropped + 4) % 5], points[dropped]);
    const nextSide = lineThrough(points[(dropped + 2) % 5], points[(dropped + 1) % 5]);
    const reconstructedCorner = lineIntersect(previousSide, nextSide);
    if (!reconstructedCorner ||
        !isFinite(reconstructedCorner.x) || !isFinite(reconstructedCorner.y)) continue;

    const quad = orderCorners([reconstructedCorner, points[(dropped + 2) % 5],
      points[(dropped + 3) % 5], points[(dropped + 4) % 5]]);
    if (!quad) continue;
    if (internalAngles(quad).some((angle) =>
      angle < PENTAGON_MIN_ANGLE_DEG || angle > PENTAGON_MAX_ANGLE_DEG)) continue;

    const score = shoelaceArea(quad) *
      (PENTAGON_AREA_WEIGHT + PENTAGON_PARALLEL_WEIGHT * parallelismOf(quad));
    if (score > bestScore) { bestScore = score; best = quad; }
  }
  return best;
}

/**
 * Collapses a convex hull to a 4-corner quad by loosening the approxPolyDP
 * epsilon until only 4 vertices remain; a 5-vertex stage is treated as a
 * corner-truncated document and reconstructed geometrically.
 */
function quadFromHull(hull) {
  const perimeter = cv.arcLength(hull, true);
  for (let epsilon = APPROX_EPSILON_START;
       epsilon <= APPROX_EPSILON_LIMIT;
       epsilon += APPROX_EPSILON_STEP) {
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(hull, approx, epsilon * perimeter, true);
      if (approx.rows === 4) return orderCorners(hullPoints(approx));
      if (approx.rows === 5) {
        const quad = pentagonToQuad(hullPoints(approx));
        if (quad) return quad;
      }
      if (approx.rows < 4) return null;
    } finally {
      approx.delete();
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------

function countBorderCorners(quad, bounds) {
  const { width, height } = bounds;
  const margin = BORDER_MARGIN_FRACTION * Math.min(width, height);
  let onBorder = 0;
  for (const point of quadPoints(quad)) {
    if (point.x < margin || point.y < margin ||
        point.x > width - margin || point.y > height - margin) onBorder++;
  }
  return onBorder;
}

/**
 * Scores how document-like a candidate quad is. Bigger is NOT automatically
 * better — a solid, well-fitting quad away from the frame edges wins over a
 * huge sloppy background quad.
 */
/** @param areas { contour, hull } — the source contour's area and its hull's */
function quadMetrics(quad, areas, bounds) {
  const { contour: contourArea, hull: hullArea } = areas;
  const quadArea = shoelaceArea(quad);
  const areaFraction = quadArea / (bounds.width * bounds.height);
  const borderCorners = countBorderCorners(quad, bounds);
  const unscored = { score: 0, quadArea, borderCorners };

  if (areaFraction < MIN_QUAD_AREA_FRACTION || areaFraction > MAX_QUAD_AREA_FRACTION) {
    return unscored;
  }
  if (hasDegenerateAngle(quad)) return unscored;

  // Solidity: merged blobs (paper plus adjacent object) go L-shaped and drop.
  const solidity = hullArea > 0 ? Math.min(1, contourArea / hullArea) : 0;
  // Fit: how closely the quad matches the hull it came from.
  const fit = quadArea > 0 && hullArea > 0
    ? Math.min(quadArea, hullArea) / Math.max(quadArea, hullArea) : 0;
  const borderFactor = 1 - BORDER_PENALTY_PER_CORNER * borderCorners;

  const score = Math.pow(solidity, SOLIDITY_EXPONENT) * fit *
    (AREA_SCORE_BASE + AREA_SCORE_WEIGHT * Math.sqrt(areaFraction)) * borderFactor;
  return { score, quadArea, borderCorners };
}

// ------------------------------------------------------------------
// Declumping a merged blob
// ------------------------------------------------------------------

/**
 * Split only a deeply notched blob whose own quad is BAD. Widening this to
 * admit rectangle-ish merges was tried and reverted: a genuine paper FOLD
 * (hard2) makes a deep mid-document crease whose two halves each protrude
 * outside the other's quad, passing the mutual-protrusion safety and cutting
 * the document in half.
 */
function shouldAttemptSplit(solidity, ownScore) {
  return solidity < SPLIT_MAX_SOLIDITY && ownScore < SPLIT_MAX_OWN_SCORE;
}

/** Quad-fits an arbitrary point list (via its convex hull) into `context.out`.
 *  @param context { width, height, out, maskName } */
function candidateFromPoints(points, context) {
  const { width, height, out, maskName } = context;
  if (points.length < MIN_POINTS_FOR_HULL) return null;
  const flat = [];
  for (const point of points) { flat.push(point.x, point.y); }
  const pointMat = cv.matFromArray(points.length, 1, cv.CV_32SC2, flat);
  const hull = new cv.Mat();
  try {
    cv.convexHull(pointMat, hull, false, true);
    let quad = quadFromHull(hull);
    if (!quad) return null;
    quad = coverQuad(quad, hullPoints(hull), context);

    const contourArea = cv.contourArea(pointMat);
    const hullArea = cv.contourArea(hull);
    const metrics = quadMetrics(quad, {
      contour: Math.max(contourArea, hullArea * CONTOUR_AREA_FLOOR_OF_HULL),
      hull: hullArea,
    }, context);

    // Marked `split` so its cut chord never joins the edge-fusion side pools.
    const candidate = {
      corners: quad,
      score: metrics.score * SPLIT_SCORE_PENALTY,
      baseScore: metrics.score,
      quadArea: metrics.quadArea,
      borderCorners: metrics.borderCorners,
      rejected: metrics.score <= 0,
      hullPts: hullPoints(hull),
      mask: maskName,
      split: true,
    };
    out.push(candidate);
    return candidate;
  } finally {
    pointMat.delete(); hull.delete();
  }
}

function contourToPoints(contour) {
  const points = [];
  for (let i = 0; i < contour.rows; i++) {
    points.push({ x: contour.data32S[i * 2], y: contour.data32S[i * 2 + 1] });
  }
  return points;
}

function boundingBoxOfPoints(points) {
  let x0 = points[0].x, y0 = points[0].y, x1 = x0, y1 = y0;
  for (const point of points) {
    if (point.x < x0) x0 = point.x;
    if (point.x > x1) x1 = point.x;
    if (point.y < y0) y0 = point.y;
    if (point.y > y1) y1 = point.y;
  }
  return { x0, y0, x1, y1 };
}

/** Convexity defects deep enough to be a two-paper seam rather than a wobble.
 *  @param mats { hullIndices, defects } — scratch Mats owned by the caller */
function deepDefectsOf(contour, mats, bounds) {
  cv.convexityDefects(contour, mats.hullIndices, mats.defects);
  const deep = [];
  const minDepth = DEEP_DEFECT_DEPTH_FRACTION * Math.min(bounds.width, bounds.height);
  const defects = mats.defects;
  for (let i = 0; i < defects.rows; i++) {
    const farIndex = defects.data32S[i * 4 + 2];
    const depth = defects.data32S[i * 4 + 3] / 256;
    if (depth > minDepth) deep.push({ far: farIndex, depth });
  }
  return deep;
}

/**
 * Two parts belong to SEPARATE objects only if each part's contour lies mostly
 * OUTSIDE the other part's quad. A notch in a single paper fails one direction
 * hard (the big part's hull-derived quad swallows the small lobe), so
 * preferring the split can never cut content there. MUTUAL by design: a
 * one-sided test would mark the small part of any notch "safe".
 *
 * Two paths qualify. Strong geometric separation on both sides; or moderate
 * separation corroborated by a real EDGE along the cut chord — an occluding
 * paper on top leaves a visible seam there, while a notch or a fold is
 * same-paper on both sides with no edge at all.
 */
function isMutuallySeparated(outsideA, outsideB, chordContrast) {
  const stronglySeparated = outsideA >= STRONG_MUTUAL_PROTRUSION &&
                            outsideB >= STRONG_MUTUAL_PROTRUSION;
  const separatedWithSeam = outsideA >= MODERATE_MUTUAL_PROTRUSION &&
                            outsideB >= MODERATE_MUTUAL_PROTRUSION &&
                            chordContrast >= MIN_CHORD_CONTRAST;
  return stronglySeparated || separatedWithSeam;
}

/** Which side of `quad` lies along the cut chord — the doc/occluder seam,
 *  which later passes must not walk across. */
function sideNearestChord(quad, chord) {
  const chordMid = { x: (chord.a.x + chord.b.x) / 2, y: (chord.a.y + chord.b.y) / 2 };
  let nearestType = 0, nearestDistance = Infinity;
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    const distance = (distToSegLine(chord.a, side.a, side.b) +
                      distToSegLine(chord.b, side.a, side.b) +
                      distToSegLine(chordMid, side.a, side.b)) / 3;
    if (distance < nearestDistance) { nearestDistance = distance; nearestType = type; }
  }
  return nearestType;
}

/** Annotates the two parts with their safety verdict and seam side. */
function annotateSplitParts(parts, chord, parentBBox) {
  for (const part of parts) {
    part.candidate.safe = part.safe;
    part.candidate.protrusionOut = part.outsideOther;
    part.candidate.protrusionIn = part.otherOutside;
    part.candidate.selfOut = part.selfOutside;
    part.candidate.parentBBox = parentBBox;
    part.candidate.cutSides = [sideNearestChord(part.candidate.corners, chord)];
    if (part.safe) part.candidate.score = part.candidate.baseScore;
  }
}

/**
 * Declumping: a document merged with an occluding paper produces deep concave
 * notches where the two meet. Cut the contour at the two deepest convexity
 * defects and quad-fit each part — the document-only part becomes a clean
 * candidate with its true edges.
 */
function splitCandidates(contour, context) {
  const { width, height, maskName, ownScore, solidity, diag, gray } = context;
  const hullIndices = new cv.Mat();
  const defects = new cv.Mat();
  try {
    cv.convexHull(contour, hullIndices, false, false);
    if (hullIndices.rows < 3) return;
    const deep = deepDefectsOf(contour, { hullIndices, defects }, context);

    const attempt = shouldAttemptSplit(solidity, ownScore);
    if (diag) {
      diag.push({ mask: maskName, solidity: +solidity.toFixed(3),
        ownScore: +ownScore.toFixed(3), nDeep: deep.length,
        depths: deep.slice(0, 3).map((d) => +(d.depth / Math.min(width, height)).toFixed(3)),
        attempt });
    }
    if (!attempt || !deep.length) return;

    deep.sort((a, b) => b.depth - a.depth);
    const cuts = deep.slice(0, 2).map((d) => d.far).sort((a, b) => a - b);
    if (cuts.length !== 2 || cuts[1] - cuts[0] <= MIN_CUT_INDEX_SEPARATION) return;

    const points = contourToPoints(contour);
    const partAPoints = points.slice(cuts[0], cuts[1] + 1);
    const partBPoints = points.slice(cuts[1]).concat(points.slice(0, cuts[0] + 1));

    // A true two-paper merge splits into two SUBSTANTIAL parts. If one part is
    // a sliver this is just an irregular outline, and splitting it would shave
    // a strip off the document.
    const areaA = polygonArea(partAPoints), areaB = polygonArea(partBPoints);
    const total = areaA + areaB;
    if (total <= 0 || Math.min(areaA, areaB) / total < MIN_PART_AREA_SHARE) return;

    const splitContext = Object.assign({}, context, { maskName: maskName + "-split" });
    const candidateA = candidateFromPoints(partAPoints, splitContext);
    const candidateB = candidateFromPoints(partBPoints, splitContext);
    if (!candidateA || !candidateB || candidateA.rejected || candidateB.rejected) return;

    const outsideBGivenA = fracOutsideQuad(partBPoints, candidateA.corners);
    const outsideAGivenB = fracOutsideQuad(partAPoints, candidateB.corners);
    const chord = { a: points[cuts[0]], b: points[cuts[1]] };
    const chordContrast = gray ? sideContrast({ gray, width, height }, chord.a, chord.b) : 0;
    const mutuallySeparated = isMutuallySeparated(outsideBGivenA, outsideAGivenB, chordContrast);

    // Self-containment: a part whose own quad fails to cover its own contour
    // (hull simplification dropped an occluded-corner vertex, leaving a
    // diagonal that slices the paper) must never win — the crop would cut
    // visible content.
    const selfOutsideA = fracOutsideQuad(partAPoints, candidateA.corners);
    const selfOutsideB = fracOutsideQuad(partBPoints, candidateB.corners);

    if (diag) {
      diag.push({ split: maskName,
        mutual: +Math.min(outsideBGivenA, outsideAGivenB).toFixed(2),
        selfMax: +Math.max(selfOutsideA, selfOutsideB).toFixed(3),
        chordContrast: +chordContrast.toFixed(2),
        safe: mutuallySeparated && Math.max(selfOutsideA, selfOutsideB) <= MAX_SELF_OUTSIDE });
    }

    annotateSplitParts([
      { candidate: candidateA, outsideOther: outsideBGivenA, otherOutside: outsideAGivenB,
        selfOutside: selfOutsideA, safe: mutuallySeparated && selfOutsideA <= MAX_SELF_OUTSIDE },
      { candidate: candidateB, outsideOther: outsideAGivenB, otherOutside: outsideBGivenA,
        selfOutside: selfOutsideB, safe: mutuallySeparated && selfOutsideB <= MAX_SELF_OUTSIDE },
    ], chord, boundingBoxOfPoints(points));
  } catch (error) {
    // convexityDefects throws on self-intersecting contours. There is nothing
    // to declump then, and the caller keeps the un-split candidate.
    return;
  } finally {
    hullIndices.delete(); defects.delete();
  }
}

// ------------------------------------------------------------------
// Mask → candidates
// ------------------------------------------------------------------

function largestContourIndices(contours) {
  const areas = [];
  for (let i = 0; i < contours.size(); i++) {
    areas.push({ index: i, area: cv.contourArea(contours.get(i)) });
  }
  areas.sort((a, b) => b.area - a.area);
  return areas.slice(0, MAX_CONTOURS_PER_MASK);
}

function candidateFromContour(contour, contourArea, context) {
  const { maskName } = context;
  const hull = new cv.Mat();
  try {
    cv.convexHull(contour, hull, false, true);
    const hullArea = cv.contourArea(hull);
    const quad = quadFromHull(hull);
    if (!quad) {
      return {
        candidate: { corners: null, score: 0, rejected: true, mask: maskName,
          noQuad: true, areaFrac: contourArea / (context.width * context.height) },
        hullArea,
      };
    }
    const metrics = quadMetrics(quad, { contour: contourArea, hull: hullArea }, context);
    return {
      candidate: { corners: quad, score: metrics.score, quadArea: metrics.quadArea,
        borderCorners: metrics.borderCorners, rejected: metrics.score <= 0,
        hullPts: hullPoints(hull), mask: maskName },
      hullArea,
    };
  } finally {
    hull.delete();
  }
}

/** Collects scored quad candidates from every sizable outer contour of a mask.
 *  @param context { width, height, out, maskName, diag, gray } */
function candidatesFromMask(bin, context) {
  const { width, height, out, maskName } = context;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (const { index, area } of largestContourIndices(contours)) {
      if (area < MIN_CONTOUR_AREA_FRACTION * width * height) break;
      const contour = contours.get(index);
      const { candidate, hullArea } = candidateFromContour(contour, area, context);
      out.push(candidate);

      // A deeply notched blob whose own quad is BAD is probably two merged
      // papers — offer the declumped parts as candidates too.
      if (hullArea > 0 && shouldAttemptSplit(area / hullArea, candidate.score)) {
        splitCandidates(contour, Object.assign({}, context,
          { ownScore: candidate.score, solidity: area / hullArea }));
      }
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}
