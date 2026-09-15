/* side-verify.js — a crop's four sides checked against the photo at its own
 * resolution. Detection runs at 800px, where a blur of two pixels hides a
 * thermal receipt's faint edge and the one-pixel seam of a sheet on its own
 * pad, and where a line of small print beyond a side is a smudge. The main
 * thread cuts a narrow strip of the full-resolution photo along each side
 * — rows across the side, columns along it — and this reads each strip's
 * column-median profile: where the sheet's edge or seam actually is, and
 * whether print of the sheet lies past the side.
 *
 * The verdict only ever makes a crop safer: a side with this sheet's print
 * beyond it moves out past the print; a side with an edge found a little
 * way out moves out to it; a side moves in only onto a seam found within a
 * hundredth of the short side with blank paper between — never onto a
 * step, which is where the crop's own margin sits. Every move keeps the
 * detector's safety margin clear of what it found. Anything else stands as
 * it was.
 *
 * Worker-global, like every worker module.
 */
"use strict";

const VERIFY = Object.freeze({
  halfWidth: 24,               // source px either side of the side: the strip's rows
  maxLength: 1600,             // columns; a longer side is resampled along its length only
  paperBand: [4, 16],          // rows inside the side that set the paper level
  paperTolerance: 25,          // levels either side of the paper level that still read as paper
  inkContrast: 40,             // a column this far below the row's level is ink…
  inkRun: 3,                   // …in a run of this many columns: a stroke, not grain
  inkShare: [0.08, 0.6],       // of a row's columns in such runs: print — a rule or an edge darkens the whole row
  minInkRuns: 2,               // print breaks along the row; an edge crossing the strip at a slant is one run
  maxInkRunShare: 0.3,         // of the width: the longest run of print, against a rule or a slanted edge
  edgeMinStep: 12,             // levels across 4 rows: an edge
  seamMinDip: 8,               // levels below both neighbours 3 rows away: a seam
  maxOutwardOfShortSide: 0.02, // a found edge this far out is taken
  maxInwardOfShortSide: 0.01,  // a found seam this far in is taken, over blank paper only
  uncutClearanceOfShortSide: 0.01,
});

/**
 * @param strips  [{ width, height, buffer }] RGBA by side type, rows across
 *                the side (row `halfWidth` is the side, rows beyond it
 *                outward), columns along it; transparent where the photo ends
 * @param quad    the crop in the photo's own pixels
 * @param bounds  the photo's { width, height }
 * @returns { quad, sides: [{ found, seam, offset, contentDepth }] } — offset
 *          the px the side was moved along its outward normal
 */
function verifySides(strips, quad, bounds) {
  const shortSide = shortSideOf(bounds);
  const lines = sideLinesOf(quad);
  const sides = strips.map((strip, type) => {
    const verdict = readStrip(strip, shortSide);
    if (verdict.offset) lines[type] = shiftedLine(lines[type], outwardNormal(quad, sideOf(quad, type)), verdict.offset);
    return verdict;
  });
  return { quad: sides.some((side) => side.offset) ? quadFromSideLines(lines, bounds) || quad : quad, sides };
}

/** One strip's verdict: the column-median gray per row, the paper level
 *  from the rows just inside, then print beyond the side, the strongest
 *  step and the narrowest dip across it. */
function readStrip(strip, shortSide) {
  const { width, height } = strip;
  const data = new Uint8ClampedArray(strip.buffer);
  const half = VERIFY.halfWidth;
  const profile = new Float32Array(height), inkShare = new Float32Array(height), seen = new Uint8Array(height);
  const inkRuns = new Uint16Array(height), inkRunMax = new Float32Array(height);
  const bins = new Uint32Array(256), gray = new Uint8Array(width);
  for (let row = 0; row < height; row++) {
    bins.fill(0);
    let count = 0;
    for (let column = 0; column < width; column++) {
      const i = (row * width + column) * 4;
      gray[column] = data[i + 3] ? Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) : 255; // past the photo: paper-bright, never ink
      if (data[i + 3]) { bins[gray[column]]++; count++; }
    }
    if (count < width / 2) continue; // mostly past the photo: unread
    seen[row] = 1;
    let acc = 0, median = 0;
    for (let value = 0; value < 256; value++) { acc += bins[value]; if (acc >= count / 2) { median = value; break; } }
    profile[row] = median;
    // Ink in runs: grain and a textured desk darken single columns, print darkens strokes.
    let ink = 0, run = 0, runs = 0, longest = 0;
    for (let column = 0; column <= width; column++) {
      if (column < width && gray[column] < median - VERIFY.inkContrast) { run++; continue; }
      if (run >= VERIFY.inkRun) { ink += run; runs++; longest = Math.max(longest, run); }
      run = 0;
    }
    inkShare[row] = ink / count;
    inkRuns[row] = runs;
    inkRunMax[row] = longest / count;
  }
  const verdict = { found: false, seam: false, offset: 0, contentDepth: 0 };
  const [from, to] = VERIFY.paperBand;
  const inside = [];
  for (let row = half - to; row <= half - from; row++) if (seen[row]) inside.push(profile[row]);
  if (inside.length < 3) return verdict; // the side is at the photo's border: nothing to read, nothing to cut
  const paper = median(inside.sort(ascending));
  const isPaper = (row) => seen[row] && Math.abs(profile[row] - paper) <= VERIFY.paperTolerance;

  // Print of this sheet beyond the side: ink rows reached over paper, with
  // paper going on past them — the sheet's own edge crossing the strip at a
  // slant darkens columns too, but no paper follows it.
  const [minInk, maxInk] = VERIFY.inkShare;
  const isPrint = (row) => inkShare[row] >= minInk && inkShare[row] <= maxInk &&
    inkRuns[row] >= VERIFY.minInkRuns && inkRunMax[row] <= VERIFY.maxInkRunShare;
  for (let row = half + 2; row < height - VERIFY.paperBand[0] && isPaper(row); row++) {
    if (isPrint(row) && isPrint(row + 1) && isPaper(row + VERIFY.paperBand[0])) {
      verdict.contentDepth = row - half;
      verdict.offset = verdict.contentDepth + VERIFY.uncutClearanceOfShortSide * shortSide;
      return verdict;
    }
  }

  const margin = SAFETY_MARGIN_FRACTION * shortSide;
  const maxOut = Math.min(height - 3 - half, VERIFY.maxOutwardOfShortSide * shortSide);
  const maxIn = Math.min(half - 3, VERIFY.maxInwardOfShortSide * shortSide);
  let bestStep = 0, stepAt = 0, seamAt = null;
  for (let row = half - maxIn; row <= half + maxOut; row++) {
    if (!seen[row - 2] || !seen[row + 2]) continue;
    const step = Math.abs(profile[row + 2] - profile[row - 2]);
    if (step > bestStep) { bestStep = step; stepAt = row; }
    const dip = Math.min(profile[row - 3], profile[row + 3]) - profile[row];
    if (seen[row - 3] && seen[row + 3] && dip >= VERIFY.seamMinDip && seamAt === null) seamAt = row;
  }
  verdict.seam = seamAt !== null;
  verdict.found = verdict.seam || bestStep >= VERIFY.edgeMinStep;
  // The side goes to the margin past what was found: out to an edge, either
  // way to a seam — inward only over blank paper, a seam with print between
  // it and the side being a rule.
  const target = (verdict.seam ? seamAt : stepAt) - half + margin;
  if (verdict.seam ? target !== 0 : bestStep >= VERIFY.edgeMinStep && target > 0) verdict.offset = target;
  if (verdict.offset < 0) {
    for (let row = half + verdict.offset; row <= half; row++) if (isPrint(row)) { verdict.offset = 0; break; }
  }
  return verdict;
}
