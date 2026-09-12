/* detector.js — the generate-and-score detector, end to end: the frame,
 * the candidates from lines and masks and the frame itself, the search, the
 * hairline safety margin. One function for detection and the live preview;
 * `preview` only trims what each stage does.
 *
 * The debug payload is what the overlay page draws: the pool lines, the
 * ranked candidates with their score breakdowns, and the winner before and
 * after refinement with the moves that got it there.
 *
 * Worker-global, like every worker module.
 */

// Final margin, so hairline errors land on background rather than content.
const DETECTOR_SAFETY_MARGIN_OF_SHORT_SIDE = 0.004;
const DEBUG_CANDIDATES_KEPT = 12;

function fullFrameQuad(frame) {
  return { tl: { x: 0, y: 0 }, tr: { x: frame.width, y: 0 },
           br: { x: frame.width, y: frame.height }, bl: { x: 0, y: frame.height } };
}

/**
 * @param img      RGBA cv.Mat at detection (≤800px) or preview (≤400px) size
 * @param options  { preview, debug }
 * @returns { corners | null, debug? }
 */
function detectDocument(img, options) {
  const preview = !!(options && options.preview);
  const wantDebug = !!(options && options.debug);
  const timing = {};
  const clock = (label, work) => {
    const started = performance.now();
    const result = work();
    timing[label] = +(performance.now() - started).toFixed(1);
    return result;
  };
  const frame = clock("frame", () => buildFrame(img, { lab: !preview, edges: !preview }));
  try {
    const candidates = [];
    const masks = clock("masks", () => maskQuads(frame, { preview }));
    for (const { quad, source } of masks) candidates.push({ quad, source, lineIds: null });
    let lines = null;
    if (!preview) {
      const maskSides = masks.flatMap(({ quad }) => [0, 1, 2, 3].map((type) => sideOf(quad, type)));
      lines = clock("lines", () => linePools(frame, maskSides));
      // Where the print is, for the scorer's seam-versus-rule question.
      frame.printExtent = printedExtent(lines.all, frame);
      for (const { quad, source } of masks) {
        const snapped = snappedToLines(quad, lines.pools, frame);
        if (snapped) candidates.push({ quad: snapped, source: "snapped:" + source, lineIds: null });
      }
    }
    candidates.push({ quad: fullFrameQuad(frame), source: "frame", lineIds: null });

    const found = clock("search", () => searchQuad(frame, candidates, { preview }, lines && lines.pools));
    if (!found) return { corners: null, debug: wantDebug ? debugPayloadOf(frame, lines, [], null, timing) : undefined };
    const margin = DETECTOR_SAFETY_MARGIN_OF_SHORT_SIDE * frame.shortSide;
    const corners = expandQuad(found.winner.quad, margin, frame);
    return {
      corners,
      debug: wantDebug ? debugPayloadOf(frame, lines, found.ranked, found.winner, timing) : undefined,
    };
  } finally {
    frame.release();
  }
}

function debugPayloadOf(frame, lines, ranked, winner, timing) {
  const roundedScore = (score) => ({
    total: +score.total.toFixed(4), geometry: +score.geometry.toFixed(3), area: +score.area.toFixed(3),
    paper: score.paper,
    sides: score.sides.map((s) => ({
      edge: +s.edge.toFixed(3), background: +s.background.toFixed(3), paperOutside: +s.paperOutside.toFixed(3),
      content: +s.content.toFixed(3), nested: +s.nested.toFixed(3), valid: s.valid, unobserved: s.unobserved,
    })),
  });
  const kept = ranked.slice(0, DEBUG_CANDIDATES_KEPT);
  const profiles = winner
    ? scoreQuad(frame, winner.quad, { keepSamples: true }).sides.map((side) =>
        (side.samples || []).map((s) => ({ point: s.point, kind: s.kind, edge: +s.edge.toFixed(3), values: s.values })))
    : null;
  return {
    engine: "score",
    timing,
    frame: { width: frame.width, height: frame.height, magnitudeScale: +frame.magnitudeScale.toFixed(1), background: frame.backgroundLab,
             printExtent: frame.printExtent },
    lines: lines ? lines.all.map((line) => ({
      id: line.id, a: line.a, b: line.b, support: Math.round(line.support), strength: Math.round(line.strength),
      pool: ["top", "right", "bottom", "left"].filter((name) => lines.pools[name].includes(line)),
    })) : [],
    candidates: kept.map((entry) => ({
      source: entry.source, lineIds: entry.lineIds, corners: entry.quad,
      rank: ranked.indexOf(entry) + 1, score: roundedScore(entry.score),
    })),
    winner: winner ? {
      from: { source: winner.from.source, rank: ranked.indexOf(winner.from) + 1 },
      before: winner.from.quad, after: winner.quad,
      scoreBefore: +winner.from.score.total.toFixed(4), scoreAfter: +winner.score.total.toFixed(4),
      moves: winner.moves, profiles,
    } : null,
  };
}
