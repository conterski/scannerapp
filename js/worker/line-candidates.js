/* line-candidates.js — the straight edges a crop's sides may jump to: the
 * legacy pipeline's Hough segments, grouped into a horizontal and a vertical
 * family, merged where collinear, and sorted into four side pools. The
 * lines carry no verdict of their own; their strength only orders the pools,
 * and the score decides. The printed rules among them also give the print's
 * extent, which tells a sheet's seam from a printed rule.
 *
 * Worker-global, like every worker module.
 */
"use strict";

const LINES = Object.freeze({
  familyBandDeg: 35,           // within this of horizontal / vertical
  mergeAngleDeg: 3,            // collinear: this close in angle…
  mergeDistance: 4,            // …and this close in px, either endpoint to the other line
  minSupportOfShortSide: 0.15, // a merged line shorter than this is print, not a sheet edge
  poolShare: 0.65,             // a horizontal line in the top 65% of the frame may be the top side
  poolSize: 7,                 // lines kept per pool
});

/**
 * Merges collinear segments of one family into lines. Each line: the fitted
 * infinite line, its support (summed segment length), its extent along the
 * line, and the angle.
 */
function mergeCollinear(segments, frame) {
  const lines = [];
  for (const segment of segments.slice().sort((p, q) => segmentLength(q) - segmentLength(p))) {
    const angle = verticalAngleDeg(segment);
    const home = lines.find((line) =>
      angleDifferenceDeg(line.angle, angle) <= LINES.mergeAngleDeg &&
      distanceToLine(segment.a, line.line) <= LINES.mergeDistance &&
      distanceToLine(segment.b, line.line) <= LINES.mergeDistance);
    if (home) {
      home.points.push(segment.a, segment.b);
      home.support += segmentLength(segment);
      home.line = fitLinePts(home.points);
      home.angle = verticalAngleDeg({ a: { x: 0, y: 0 }, b: { x: home.line.dx, y: home.line.dy } });
    } else {
      lines.push({ points: [segment.a, segment.b], support: segmentLength(segment),
                   line: lineThrough(segment.a, segment.b), angle });
    }
  }
  const minSupport = LINES.minSupportOfShortSide * frame.shortSide;
  return lines.filter((line) => line.support >= minSupport).map((line) => finishLine(line, frame));
}

/** The line's extent (its outermost supporting points projected onto it),
 *  its midpoint, and its strength: support weighted by the gradient along it. */
function finishLine(line, frame) {
  const { a, b } = spanAlongLine(line.line, line.points);
  const normal = { nx: -line.line.dy, ny: line.line.dx };
  let edgeSum = 0, count = 0;
  for (let t = 0.05; t < 1; t += 0.1) {
    const point = pointAlong(a, b, t);
    const x = Math.round(point.x), y = Math.round(point.y);
    if (!insideBounds(frame, x, y)) continue;
    edgeSum += Math.min(1, frameMagnitudeAt(frame, x, y) / frame.magnitudeScale) * gradientAcross(frame, x, y, normal);
    count++;
  }
  return { line: line.line, a, b, angle: line.angle, support: line.support,
           strength: line.support * (count ? edgeSum / count : 0),
           mid: midpointOf({ a, b }) };
}

/**
 * The four pools, indexed by side type, each the strongest lines that could
 * be that side. The top and bottom pools overlap (a line in the middle band
 * could be either), as do left and right.
 * @param segments Hough segments {a, b}
 * @returns { pools: [top, right, bottom, left], all } — lines with `id`
 */
function linePools(frame, segments) {
  const isHorizontal = (s) => angleDifferenceDeg(verticalAngleDeg(s), 0) <= LINES.familyBandDeg;
  const isVertical = (s) => angleDifferenceDeg(verticalAngleDeg(s), 90) <= LINES.familyBandDeg;
  const horizontal = mergeCollinear(segments.filter(isHorizontal), frame);
  const vertical = mergeCollinear(segments.filter(isVertical), frame);
  const byStrength = (p, q) => q.strength - p.strength;
  const share = LINES.poolShare;
  const pool = (lines, mayBe) => lines.filter(mayBe).sort(byStrength).slice(0, LINES.poolSize);
  const pools = [];
  pools[SIDE_TOP] = pool(horizontal, (l) => l.mid.y <= frame.height * share);
  pools[SIDE_RIGHT] = pool(vertical, (l) => l.mid.x >= frame.width * (1 - share));
  pools[SIDE_BOTTOM] = pool(horizontal, (l) => l.mid.y >= frame.height * (1 - share));
  pools[SIDE_LEFT] = pool(vertical, (l) => l.mid.x <= frame.width * share);
  const all = [...horizontal, ...vertical];
  all.forEach((line, id) => { line.id = id; });
  return { pools, all };
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
 * @returns { left, top, right, bottom, rules } in frame px, or null
 */
function printedExtent(lines, frame) {
  const depths = probeDepths(frame.scale);
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
  return { left: percentileOf(xs, PRINT.extentPercentile), right: percentileOf(xs, 1 - PRINT.extentPercentile),
           top: percentileOf(ys, PRINT.extentPercentile), bottom: percentileOf(ys, 1 - PRINT.extentPercentile), rules };
}
