/* side-refit.js — a side extrapolated from the part of its edge that can
 * be seen. A folded-back page over one corner of a sheet hides part of an
 * edge, and the detectors run the side along the fold's outer edge instead:
 * the crop then carries a wedge of the fold. Along the rest of the side the
 * sheet's edge is in plain view, and it is a straight line — so the side is
 * refitted to the edge points the samples can see, the line carried on
 * behind the fold, and the fold's wedge falls outside the crop.
 *
 * The refit is a geometric move, not a scored one: the score reads a side
 * against the pixels along it, and a side behind a fold has no pixels to
 * be read against. What is asked of it instead: a run of the samples
 * locate an edge on one line; that line is the side's own or lies inward
 * of it (a sheet's edge behind an occluder is never outward of the fold);
 * and along that run, what lies beyond the line is not the sheet going on
 * — not paper, not print — which is what tells the sheet's edge from a
 * printed border or a crease the samples might have found instead.
 *
 * Worker-global, like every worker module.
 */
"use strict";

const REFIT = Object.freeze({
  samples: 32,
  reachOfShortSide: 0.10,      // how far across the side an edge is looked for, each way
  minGradientShare: 0.6,       // of the frame's magnitude scale: an edge, not grain
  inlierTolerance: 2,          // px at 800px, from the fitted line
  // A fold can hide well over half a side; what remains must still be a
  // run of samples on one line, not a scatter that happens to align.
  minConsensus: 0.3,           // of the samples, on one stretch of the side
  maxGapInStretch: 1,          // samples without the edge that a stretch may bridge
  minMove: 2,                  // px at 800px: less, and the descent does it
  // The line may stand a little outward of the side at its visible end —
  // the detectors leave a side a few px inside its edge — but no more: an
  // outward line is a fold's or a pad's edge, not a hidden one.
  outwardAllowance: 6,         // px at 800px
  maxInwardOfShortSide: 0.3,   // the occluded end may move in by this much: a fold over a corner is a wedge
  passes: 2,                   // rounds over the four sides
  // Along the visible stretch, the line must be the sheet's edge and not
  // a printed border the samples found instead. A border sits at the
  // print's extent with the sheet's margin — paper — beyond it; an edge
  // lies clear of the print (the seam rule, SCORE.nested) or has the desk
  // beyond it, and a sheet on its pad has paper beyond its edge but the
  // print clear of it, so neither sign alone convicts: both together do.
  // Past an edge there is no print at all. The occluded stretch is not
  // asked: beyond it lies the fold.
  maxInsidePrint: 0.25,        // of the stretch's samples within the print's extent…
  maxPaperBeyond: 0.25,        // …and of them with paper past the line
  maxContentBeyond: 0.1,       // of the stretch's samples with print past the line
});

/**
 * Every side refitted in turn, each accepted refit carried into the next.
 * @returns { quad, moves: [{ side, kind: "refit", amount, consensus }],
 *            tried: [{ side, pass, consensus, inward, refused, located, line }] }
 *          — tried is every side's attempt, for the overlay page
 */
function refitSides(frame, quad) {
  const palette = paletteFor(frame, quad);
  let current = quad;
  const moves = [], tried = [];
  // A fold over a corner hides the end of two sides, and refitting one
  // moves the corner the other reaches to: a side whose visible edge was
  // out of reach before may be within it now, so the sides go round again
  // until a pass moves nothing.
  for (let pass = 0; pass < REFIT.passes; pass++) {
    let moved = false;
    for (let type = 0; type < SIDE_COUNT; type++) {
      const refit = refitSide(frame, current, type, palette);
      tried.push({ side: type, pass, consensus: refit.consensus, inward: +refit.inward.toFixed(1), refused: refit.refused,
                   located: refit.located, line: refit.line });
      if (refit.refused) continue;
      current = refit.quad;
      moved = true;
      moves.push({ side: type, kind: "refit", amount: +refit.inward.toFixed(2), consensus: refit.consensus });
    }
    if (!moved) break;
  }
  return { quad: current, moves, tried };
}

/** One side's refit: { consensus, inward, located, line, refused } with
 *  `refused` naming the rule the line failed, or null and `quad` when it
 *  passed. */
function refitSide(frame, quad, type, palette) {
  const scale = frame.scale;
  const located = locateEdges(frame, quad, type, scale);
  const fit = consensusLine(located, REFIT.inlierTolerance * scale);
  const outcome = { consensus: fit ? fit.consensus : 0, inward: 0, refused: null, located, line: fit && fit.line };
  const refuse = (rule) => ({ ...outcome, refused: rule });
  if (!fit || !fit.line) return refuse("consensus");

  const drifts = driftsOf(quad, type, fit.line);
  const inward = -Math.min(...drifts);
  outcome.inward = inward;
  if (Math.max(...drifts) > REFIT.outwardAllowance * scale) return refuse("outward");
  if (inward < REFIT.minMove * scale) return refuse("still");
  if (inward > REFIT.maxInwardOfShortSide * frame.shortSide) return refuse("far");

  const beyond = beyondTheStretch(frame, quad, type, fit.inliers, palette, scale);
  if (beyond.content > REFIT.maxContentBeyond) return refuse("content");
  if (beyond.insidePrint > REFIT.maxInsidePrint && beyond.paper > REFIT.maxPaperBeyond) return refuse("print");

  const lines = sideLinesOf(quad);
  lines[type] = fit.line;
  const refitted = quadFromSideLines(lines, frame);
  if (!refitted || geometryRejection(refitted, frame)) return refuse("shape");
  return { ...outcome, quad: refitted };
}

/** The stretch's points against the print: the shares lying within the
 *  print's extent (all of them when no print was found to measure
 *  against), with paper past the line (at the far and band depths both),
 *  and with print past the line. */
function beyondTheStretch(frame, quad, type, inliers, palette, scale) {
  const normal = outwardNormal(quad, sideOf(quad, type));
  const at = (point, depth) => alongNormal(point, normal, depth);
  const seamClearance = SCORE.nested.minSeamFromPrint * frame.shortSide;
  let insidePrint = 0, paper = 0, content = 0;
  for (const point of inliers) {
    if (!frame.printExtent || distanceOutsidePrint(point, type, frame.printExtent) < seamClearance) insidePrint++;
    const far = at(point, SCORE.depths.far * scale), band = at(point, SCORE.depths.band * scale);
    if (insideBounds(frame, far.x, far.y) && insideBounds(frame, band.x, band.y) &&
        palette.isPaper(far.x, far.y) && palette.isPaper(band.x, band.y)) paper++;
    if (contentOutside(frame, { point, scale }, normal, palette)) content++;
  }
  return { insidePrint: insidePrint / inliers.length, paper: paper / inliers.length, content: content / inliers.length };
}

/**
 * Where the edge is at each sample along the side: the outermost strong
 * across-the-side gradient peak within reach. Outermost, so a printed rule
 * inside the sheet never stands in for the sheet's edge; a peak, so the
 * point sits on the edge and not merely near it.
 * @returns an array of REFIT.samples entries, each a point or null
 */
function locateEdges(frame, quad, type, scale) {
  const side = sideOf(quad, type);
  const normal = outwardNormal(quad, side);
  const reach = Math.round(REFIT.reachOfShortSide * frame.shortSide);
  const minAcross = REFIT.minGradientShare * frame.magnitudeScale;
  const located = [];
  const across = new Float32Array(2 * reach + 1);
  for (let i = 0; i < REFIT.samples; i++) {
    const centre = pointAlong(side.a, side.b, (i + 0.5) / REFIT.samples);
    for (let offset = -reach; offset <= reach; offset++) {
      const { x, y } = alongNormal(centre, normal, offset);
      across[offset + reach] = insideBounds(frame, x, y) ? gradientAlong(frame, x, y, normal) : 0;
    }
    let found = null;
    for (let k = across.length - 2; k >= 1 && !found; k--) {
      if (across[k] >= minAcross && across[k] >= across[k - 1] && across[k] >= across[k + 1]) {
        const offset = k - reach;
        found = { x: centre.x + normal.nx * offset, y: centre.y + normal.ny * offset };
      }
    }
    located.push(found);
  }
  return located;
}

/**
 * The line most of the located points lie on, when there is one: the
 * largest set within tolerance of a line through two of them, refitted to
 * that set, provided the set is one stretch of consecutive samples (a fold
 * hides one end of a side, it does not perforate it).
 * @returns { line, inliers, consensus } — line null when the consensus
 *          falls short; null with fewer than two points
 */
function consensusLine(located, tolerance) {
  const points = located.map((point, index) => point && { ...point, index }).filter(Boolean);
  const needed = Math.ceil(REFIT.minConsensus * located.length);
  if (points.length < 2) return null;
  let best = null;
  for (let p = 0; p < points.length; p++) {
    for (let q = p + 1; q < points.length; q++) {
      const line = lineThrough(points[p], points[q]);
      const inliers = points.filter((point) => distanceToLine(point, line) <= tolerance);
      if ((!best || inliers.length > best.length) && isOneStretch(inliers)) best = inliers;
    }
  }
  if (!best) return null;
  const consensus = +(best.length / located.length).toFixed(2);
  return best.length >= needed ? { line: fitLinePts(best), inliers: best, consensus } : { line: null, consensus };
}

function isOneStretch(inliers) {
  for (let i = 1; i < inliers.length; i++) {
    if (inliers[i].index - inliers[i - 1].index > REFIT.maxGapInStretch + 1) return false;
  }
  return true;
}
