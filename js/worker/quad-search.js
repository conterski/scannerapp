/* quad-search.js — picks the best candidate quad and refines it.
 *
 * The candidates are regions — every mask quad and the whole frame — and
 * the score chooses among them and then refines the best few by coordinate
 * descent on the same score: each side tried at a few offsets along its
 * normal, a few small rotations, and every pool line within reach, both
 * directions, one accepted move per iteration. Inward moves are allowed —
 * the old detector could only grow, which is why it ran loose. Free line
 * combinations are not candidates: four strong lines bound a table's rows
 * as readily as a sheet, and a score that tells the two apart in every
 * lighting proved harder to write than a search that starts from a region
 * and lets the lines place its sides.
 *
 * Worker-global, like every worker module.
 */

const SEARCH = Object.freeze({
  contendersRefined: 6,        // the best region quads are refined; the rest were not close
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
    previewOffsets: [1, 2, 4],
    rotationsDeg: [0.5, 1],    // about the side's midpoint, both ways
    maxIterations: 12,
    previewMaxIterations: 6,
    minGain: 0.002,
    maxDriftOfShortSide: 0.06, // a side may leave its candidate's line by this much
  },
});

/**
 * Scores every candidate and returns them ranked, best first. Each entry:
 * { quad, source, lineIds, score } with the full breakdown.
 */
function rankCandidates(frame, candidates, options) {
  const ranked = [];
  for (const candidate of candidates) {
    const score = scoreQuad(frame, candidate.quad, options);
    if (score.rejected) continue;
    ranked.push({ ...candidate, score });
  }
  return ranked.sort((p, q) => q.score.total - p.score.total);
}

/** The side lines of a quad, indexed by side type. */
function sideLinesOf(quad) {
  const lines = [];
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    lines.push(lineThrough(side.a, side.b));
  }
  return lines;
}

/** `line` moved by `offset` along the quad's outward normal for that side. */
function shiftedLine(quad, type, line, offset) {
  const normal = outwardNormal(quad, sideOf(quad, type));
  return { px: line.px + normal.nx * offset, py: line.py + normal.ny * offset, dx: line.dx, dy: line.dy };
}

/** `line` rotated by `degrees` about the side's midpoint. */
function rotatedLine(quad, type, line, degrees) {
  const side = sideOf(quad, type);
  const mid = { x: (side.a.x + side.b.x) / 2, y: (side.a.y + side.b.y) / 2 };
  const angle = degrees * Math.PI / 180;
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
    const along = (end.x - line.px) * line.dx + (end.y - line.py) * line.dy;
    const nearest = { x: line.px + line.dx * along, y: line.py + line.dy * along };
    return (nearest.x - end.x) * normal.nx + (nearest.y - end.y) * normal.ny;
  });
}

function driftOf(quad, type, line) {
  return Math.max(...driftsOf(quad, type, line).map(Math.abs));
}

/**
 * Coordinate descent from `start` on the score. The trial moves are judged
 * without the nested term — an inward march per sample, the costliest part
 * of a score, and one that barely moves under a shift of a few px — and the
 * refined quad gets its full score at the end.
 * @param options { preview, inwardOnly } — inwardOnly caps outward drift at
 *                SEARCH.outwardAllowance
 * @param pools   the line pools, for the jump-to-a-line moves; null without
 * @returns { quad, score, moves: [{ side, kind, amount, gain }] }
 */
function refineQuad(frame, start, options, pools) {
  const preview = !!(options && options.preview);
  const { rotationsDeg, minGain, maxDriftOfShortSide } = SEARCH.refine;
  const scale = frame.shortSide / SCORE.referenceShortSide;
  const offsets = (preview ? SEARCH.refine.previewOffsets : SEARCH.refine.offsets).map((px) => px * scale);
  const maxIterations = preview ? SEARCH.refine.previewMaxIterations : SEARCH.refine.maxIterations;
  const maxDrift = maxDriftOfShortSide * frame.shortSide;
  const maxOutward = options && options.inwardOnly ? SEARCH.outwardAllowance * scale : maxDrift;
  // One palette for the whole descent — the paper does not change colour
  // as a side moves a few px — and only the moved side is re-read: its
  // neighbours' endpoints shift by less than a sample spacing.
  const trialOptions = { ...options, withoutNested: true, palette: paletteFor(frame, start) };

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
      for (const offset of offsets) {
        consider(type, "offset", offset, shiftedLine(current.quad, type, lines[type], offset));
        consider(type, "offset", -offset, shiftedLine(current.quad, type, lines[type], -offset));
      }
      for (const degrees of rotationsDeg) {
        consider(type, "rotate", degrees, rotatedLine(current.quad, type, lines[type], degrees));
        consider(type, "rotate", -degrees, rotatedLine(current.quad, type, lines[type], -degrees));
      }
      if (pools) {
        for (const line of pools[POOL_NAMES[type]]) {
          if (driftOf(current.quad, type, line.line) <= maxDrift) consider(type, "line", line.id, line.line);
        }
      }
    }
    if (!best) break;
    current = { quad: best.quad, score: best.score };
    moves.push({ side: best.side, kind: best.kind, amount: +best.amount.toFixed(2), gain: +best.gain.toFixed(4) });
  }
  return { quad: current.quad, score: scoreQuad(frame, current.quad, options), moves };
}

const POOL_NAMES = ["top", "right", "bottom", "left"]; // by side type

/**
 * `quad` refined on the score, or `quad` itself when refinement gains less
 * than SEARCH.acceptGain — a crop that arrived here is a detector's answer,
 * and a marginal preference is not a reason to move it.
 * @returns { quad, refined: bool, scoreBefore, scoreAfter, moves }
 */
function refineGivenQuad(frame, quad, pools) {
  const before = scoreQuad(frame, quad);
  if (before.rejected) return { quad, refined: false, scoreBefore: before.total, scoreAfter: before.total, moves: [] };
  const result = refineQuad(frame, quad, { inwardOnly: true }, pools);
  const refined = result.score.total - before.total >= SEARCH.acceptGain;
  return { quad: refined ? result.quad : quad, refined, scoreBefore: before.total, scoreAfter: result.score.total, moves: result.moves };
}

/**
 * The best quad among the candidates, refined. The best few are refined —
 * a hull sits a few px off the edges it found, and scores low until it is
 * moved onto them — and the refined scores decide.
 * @returns { winner: { quad, score, moves, from }, ranked } or null
 */
function searchQuad(frame, candidates, options, pools) {
  const ranked = rankCandidates(frame, candidates, options);
  if (!ranked.length) return null;
  let winner = null;
  for (const contender of ranked.slice(0, SEARCH.contendersRefined)) {
    const refined = refineQuad(frame, contender.quad, options, pools);
    if (!winner || refined.score.total > winner.score.total) winner = { ...refined, from: contender };
  }
  return { winner, ranked };
}
