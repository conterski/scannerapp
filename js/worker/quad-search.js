/* quad-search.js — refines a crop by coordinate descent on the score.
 *
 * Each side is tried at a few offsets along its normal, a few small
 * rotations, and every pool line within reach, both directions, one accepted
 * move per iteration. Inward moves are allowed — the legacy pipeline can
 * only grow, which is why it runs loose. Free line combinations are not
 * candidates: four strong lines bound a table's rows as readily as a sheet,
 * and a score that tells the two apart in every lighting proved harder to
 * write than a search that starts from a crop and lets the lines place its
 * sides.
 *
 * Worker-global, like every worker module.
 */
"use strict";

const SEARCH = Object.freeze({
  // Refining another detector's crop: its result is trusted unless the
  // refined one scores clearly better — the score judges moves of a few
  // px well and whole relocations badly, so it is only asked the first.
  // And it may only tighten: the legacy crop's failure is looseness, never
  // a cut, and the score, offered outward moves, took a pad's edge or a
  // fold for the sheet's on the very scenes the refinement is for.
  acceptGain: 0.03,
  outwardAllowance: 2,         // px at 800px a side may still move outward, to sit on its edge
  refine: {
    offsets: [1, 2, 4, 8],     // px along the normal, both ways, at 800px
    rotationsDeg: [0.5, 1],    // about the side's midpoint, both ways
    maxIterations: 12,
    minGain: 0.002,
    maxDriftOfShortSide: 0.10, // a side may leave its candidate's line by this much: the seam under a receipt on a page lies this deep
  },
});

/** `line` rotated by `degrees` about the side's midpoint. */
function rotatedLine(quad, type, line, degrees) {
  const mid = midpointOf(sideOf(quad, type));
  const angle = degrees * DEG;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { px: mid.x, py: mid.y, dx: line.dx * cos - line.dy * sin, dy: line.dx * sin + line.dy * cos };
}

/** How far a line lies from a side at each of the side's ends, signed along
 *  the side's outward normal: positive is outward. Both ends, so a line that
 *  crosses the side near its middle cannot pass as a small move. */
function driftsOf(quad, type, line) {
  const side = sideOf(quad, type);
  const normal = outwardNormal(quad, side);
  return [side.a, side.b].map((end) => {
    const along = projectionAlong(end, line);
    const nearest = { x: line.px + line.dx * along, y: line.py + line.dy * along };
    return (nearest.x - end.x) * normal.nx + (nearest.y - end.y) * normal.ny;
  });
}

/**
 * Coordinate descent from `start` on the score. The trial moves are judged
 * without the nested term — an inward march per sample, the costliest part
 * of a score, and one that barely moves under a shift of a few px — and the
 * refined quad gets its full score at the end. Outward drift is capped at
 * SEARCH.outwardAllowance, inward at the refine's maxDriftOfShortSide.
 * @param pools the line pools by side type, for the jump-to-a-line moves
 * @returns { quad, score, moves: [{ side, kind, amount, gain }] }
 */
function refineQuad(frame, start, pools) {
  const { offsets, rotationsDeg, maxIterations, minGain, maxDriftOfShortSide } = SEARCH.refine;
  const maxDrift = maxDriftOfShortSide * frame.shortSide;
  const maxOutward = SEARCH.outwardAllowance * frame.scale;
  // One palette for the whole descent — the paper does not change colour
  // as a side moves a few px — and only the moved side is re-read: its
  // neighbours' endpoints shift by less than a sample spacing.
  const trialOptions = { withoutNested: true, palette: paletteFor(frame, start) };

  let current = { quad: start, score: scoreQuad(frame, start, trialOptions) };
  const moves = [];
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const lines = sideLinesOf(current.quad);
    let best = null;
    const consider = (type, kind, amount, line) => {
      if (driftsOf(start, type, line).some((drift) => drift < -maxDrift || drift > maxOutward)) return;
      const trial = lines.slice();
      trial[type] = line;
      const quad = quadFromSideLines(trial, frame);
      if (!quad) return;
      const reuseSides = current.score.sides.map((side, other) => (other === type ? null : side));
      const score = scoreQuad(frame, quad, { ...trialOptions, reuseSides });
      const gain = score.total - current.score.total;
      if (gain > minGain && (!best || gain > best.gain)) best = { quad, score, gain, side: type, kind, amount };
    };
    for (let type = 0; type < SIDE_COUNT; type++) {
      const normal = outwardNormal(current.quad, sideOf(current.quad, type));
      for (const px of offsets) {
        const offset = px * frame.scale;
        consider(type, "offset", offset, shiftedLine(lines[type], normal, offset));
        consider(type, "offset", -offset, shiftedLine(lines[type], normal, -offset));
      }
      for (const degrees of rotationsDeg) {
        consider(type, "rotate", degrees, rotatedLine(current.quad, type, lines[type], degrees));
        consider(type, "rotate", -degrees, rotatedLine(current.quad, type, lines[type], -degrees));
      }
      for (const line of pools[type]) {
        const within = driftsOf(current.quad, type, line.line).every((drift) => Math.abs(drift) <= maxDrift);
        if (within) consider(type, "line", line.id, line.line);
      }
    }
    if (!best) break;
    current = { quad: best.quad, score: best.score };
    moves.push({ side: best.side, kind: best.kind, amount: +best.amount.toFixed(2), gain: +best.gain.toFixed(4) });
  }
  return { quad: current.quad, score: scoreQuad(frame, current.quad), moves };
}

/**
 * `quad` refined on the score, or `quad` itself when refinement gains less
 * than SEARCH.acceptGain — a crop that arrived here is a detector's answer,
 * and a marginal preference is not a reason to move it. Sides hidden in
 * part by a fold are first refitted to their visible edge (side-refit.js),
 * and the descent starts from there.
 * @returns { quad, refined: bool, scoreBefore, scoreAfter, moves, refits }
 */
function refineGivenQuad(frame, quad, pools) {
  const before = scoreQuad(frame, quad);
  if (before.rejected) return { quad, refined: false, scoreBefore: before.total, scoreAfter: before.total, moves: [], refits: [] };
  const refit = refitSides(frame, quad);
  const result = refineQuad(frame, refit.quad, pools);
  const refined = result.score.total - before.total >= SEARCH.acceptGain;
  return { quad: refined ? result.quad : quad, refined, scoreBefore: before.total, scoreAfter: result.score.total,
           moves: refit.moves.concat(result.moves), refits: refit.tried };
}
