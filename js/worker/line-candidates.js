/* line-candidates.js — candidate quads from straight edges: Hough segments,
 * grouped into a horizontal and a vertical family, merged where collinear,
 * sorted into four side pools, and combined top × bottom × left × right.
 *
 * The lines carry no verdict of their own. Their strength only orders the
 * pools and pre-ranks the combinations, so the scorer sees the few dozen
 * most plausible quads first; the scorer decides.
 *
 * Worker-global, like every worker module.
 */

const LINES = Object.freeze({
  hough: { threshold: 40, minLengthOfShortSide: 0.10, maxGap: 8, maxSegments: 120 },
  familyBandDeg: 35,           // within this of horizontal / vertical
  mergeAngleDeg: 3,            // collinear: this close in angle…
  mergeDistance: 4,            // …and this close in px, either endpoint to the other line
  minSupportOfShortSide: 0.15, // a merged line shorter than this is print, not a sheet edge
  poolShare: 0.65,             // a horizontal line in the top 65% of the frame may be the top side
  poolSize: 7,                 // lines kept per pool: 7^4 combinations at most
  minSeparationOfShortSide: 0.2, // top above bottom, left left of right, by at least this
});

function segmentLengthOf(segment) { return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y); }

/** Angle in degrees, folded to [0, 180). */
function segmentAngleOf(segment) {
  const angle = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x) * 180 / Math.PI;
  return ((angle % 180) + 180) % 180;
}

/** Smallest angle between two folded angles, 0..90. */
function angleGapDeg(first, second) {
  const gap = Math.abs(first - second) % 180;
  return Math.min(gap, 180 - gap);
}

function houghSegments(frame) {
  const linesMat = new cv.Mat();
  const segments = [];
  try {
    const { threshold, minLengthOfShortSide, maxGap, maxSegments } = LINES.hough;
    cv.HoughLinesP(frame.canny, linesMat, 1, Math.PI / 180, threshold, minLengthOfShortSide * frame.shortSide, maxGap);
    for (let i = 0; i < Math.min(linesMat.rows, maxSegments); i++) {
      segments.push({
        a: { x: linesMat.data32S[i * 4], y: linesMat.data32S[i * 4 + 1] },
        b: { x: linesMat.data32S[i * 4 + 2], y: linesMat.data32S[i * 4 + 3] },
      });
    }
  } finally {
    linesMat.delete();
  }
  return segments;
}

/** Perpendicular distance from a point to an infinite line {px, py, dx, dy}. */
function distanceToLine(point, line) {
  return Math.abs((point.x - line.px) * line.dy - (point.y - line.py) * line.dx);
}

/**
 * Merges collinear segments of one family into lines. Each line: the fitted
 * infinite line, its support (summed segment length), its extent along the
 * line, and the angle.
 */
function mergeCollinear(segments, frame) {
  const lines = [];
  for (const segment of segments.slice().sort((p, q) => segmentLengthOf(q) - segmentLengthOf(p))) {
    const angle = segmentAngleOf(segment);
    const home = lines.find((line) =>
      angleGapDeg(line.angle, angle) <= LINES.mergeAngleDeg &&
      distanceToLine(segment.a, line.line) <= LINES.mergeDistance &&
      distanceToLine(segment.b, line.line) <= LINES.mergeDistance);
    if (home) {
      home.points.push(segment.a, segment.b);
      home.support += segmentLengthOf(segment);
      home.line = fitLinePts(home.points);
      home.angle = segmentAngleOf({ a: { x: 0, y: 0 }, b: { x: home.line.dx, y: home.line.dy } });
    } else {
      lines.push({ points: [segment.a, segment.b], support: segmentLengthOf(segment),
                   line: lineThrough(segment.a, segment.b), angle });
    }
  }
  const minSupport = LINES.minSupportOfShortSide * frame.shortSide;
  return lines.filter((line) => line.support >= minSupport).map((line) => finishLine(line, frame));
}

/** The line's extent (its outermost supporting points projected onto it),
 *  its midpoint, and its strength: support weighted by the gradient along it. */
function finishLine(line, frame) {
  const { px, py, dx, dy } = line.line;
  let first = Infinity, last = -Infinity;
  for (const point of line.points) {
    const along = (point.x - px) * dx + (point.y - py) * dy;
    first = Math.min(first, along);
    last = Math.max(last, along);
  }
  const a = { x: px + dx * first, y: py + dy * first }, b = { x: px + dx * last, y: py + dy * last };
  const normal = { nx: -dy, ny: dx };
  let edgeSum = 0, count = 0;
  for (let t = 0.05; t < 1; t += 0.1) {
    const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
    if (!insideFrame(frame, x, y)) continue;
    edgeSum += Math.min(1, frameMagnitudeAt(frame, x, y) / frame.magnitudeScale) * gradientAcross(frame, x, y, normal);
    count++;
  }
  return { line: line.line, a, b, angle: line.angle, support: line.support,
           strength: line.support * (count ? edgeSum / count : 0),
           mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/**
 * The four pools, each the strongest lines that could be that side. The top
 * and bottom pools overlap (a line in the middle band could be either), as
 * do left and right. Besides the Hough lines, every side of every mask quad
 * joins the pools: a hull that is right on three sides contributes those
 * three, and the combinations supply the fourth from elsewhere — what the
 * old detector did with a fusion pass, done here by enumeration.
 * @param extraSides  [{a, b}] segments to add, from the mask quads
 * @returns { pools: { top, right, bottom, left }, all } — lines with `id`
 */
function linePools(frame, extraSides) {
  const segments = houghSegments(frame);
  const isHorizontal = (s) => angleGapDeg(segmentAngleOf(s), 0) <= LINES.familyBandDeg;
  const isVertical = (s) => angleGapDeg(segmentAngleOf(s), 90) <= LINES.familyBandDeg;
  const horizontal = mergeCollinear(segments.filter(isHorizontal), frame);
  const vertical = mergeCollinear(segments.filter(isVertical), frame);
  for (const side of extraSides || []) {
    const line = finishLine({ points: [side.a, side.b], support: segmentLengthOf(side), line: lineThrough(side.a, side.b), angle: segmentAngleOf(side) }, frame);
    if (isHorizontal(side)) horizontal.push(line);
    else if (isVertical(side)) vertical.push(line);
  }
  const byStrength = (p, q) => q.strength - p.strength;
  const share = LINES.poolShare;
  const pools = {
    top: horizontal.filter((l) => l.mid.y <= frame.height * share).sort(byStrength).slice(0, LINES.poolSize),
    bottom: horizontal.filter((l) => l.mid.y >= frame.height * (1 - share)).sort(byStrength).slice(0, LINES.poolSize),
    left: vertical.filter((l) => l.mid.x <= frame.width * share).sort(byStrength).slice(0, LINES.poolSize),
    right: vertical.filter((l) => l.mid.x >= frame.width * (1 - share)).sort(byStrength).slice(0, LINES.poolSize),
  };
  let id = 0;
  for (const line of [...horizontal, ...vertical]) line.id = id++;
  return { pools, all: [...horizontal, ...vertical] };
}

const PRINT = Object.freeze({
  minSupportOfShortSide: 0.2,  // a rule this long is part of the table, not a stray mark
  samplesPerLine: 7,
  minPrintedShare: 0.6,        // of the samples that read as a printed line (paper both sides)
  minRules: 3,
  extentPercentile: 0.1,       // the extent ignores the odd stray rule at either end
});

/**
 * Where the print is: the box the printed rules span. A rule has paper on
 * both sides of a dark line; the sheet's own edge and the desk's grain do
 * not. Null when the photo has too few rules to say — a plain receipt.
 * @returns { left, top, right, bottom } in frame px, or null
 */
function printedExtent(lines, frame) {
  const scale = frame.shortSide / SCORE.referenceShortSide;
  const depths = probeDepths(scale);
  const xs = [], ys = [];
  let rules = 0;
  for (const line of lines) {
    if (line.support < PRINT.minSupportOfShortSide * frame.shortSide) continue;
    const normal = { nx: -line.line.dy, ny: line.line.dx };
    let printed = 0;
    for (let i = 0; i < PRINT.samplesPerLine; i++) {
      const values = profileAcross(frame, pointAlong(line.a, line.b, (i + 0.5) / PRINT.samplesPerLine), normal, depths);
      if (values && classifyProfile(values).kind === SAMPLE_KIND_LINE) printed++;
    }
    if (printed < PRINT.minPrintedShare * PRINT.samplesPerLine) continue;
    rules++;
    xs.push(line.a.x, line.b.x);
    ys.push(line.a.y, line.b.y);
  }
  if (rules < PRINT.minRules) return null;
  xs.sort(ascending); ys.sort(ascending);
  const at = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  return { left: at(xs, PRINT.extentPercentile), right: at(xs, 1 - PRINT.extentPercentile),
           top: at(ys, PRINT.extentPercentile), bottom: at(ys, 1 - PRINT.extentPercentile), rules };
}

/**
 * Every top × right × bottom × left combination that could be a sheet,
 * pre-ranked by the lines' strength alone (no pixel work): the scorer takes
 * the best `limit` of them.
 * @returns [{ quad, lineIds, prerank }]
 */
function lineQuads(pools, frame, limit) {
  const separation = LINES.minSeparationOfShortSide * frame.shortSide;
  const quads = [];
  for (const top of pools.top) {
    for (const bottom of pools.bottom) {
      if (top === bottom || bottom.mid.y - top.mid.y < separation) continue;
      for (const left of pools.left) {
        for (const right of pools.right) {
          if (left === right || right.mid.x - left.mid.x < separation) continue;
          const quad = quadFromSideLines([top.line, right.line, bottom.line, left.line], frame);
          if (!quad || geometryRejection(quad, frame)) continue;
          quads.push({ quad, lineIds: [top.id, right.id, bottom.id, left.id],
                       prerank: top.strength + right.strength + bottom.strength + left.strength - geometryPenalty(quad) * frame.shortSide });
        }
      }
    }
  }
  return quads.sort((p, q) => q.prerank - p.prerank).slice(0, limit);
}
