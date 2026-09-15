/* quad-score.js — one number for a candidate quad: how much it looks like
 * the crop CRITERIA.md asks for.
 *
 * Each side is sampled along its length and every sample is classified by
 * its gray profile across the side — a step (paper ends), a shadow step (the
 * top sheet's seam over its pad), a printed line (same paper both sides), or
 * nothing. From those samples come five terms per side, each a share in
 * 0..1:
 *
 *   E  edge support        the side lies on a boundary            (rule 3)
 *   B  background inside   the side is out on the desk            (rule 2)
 *   P  paper outside       the side sits inside the sheet         (rules 1, 3)
 *   C  content outside     print just past the side                (rule 1)
 *   N  nested boundary     a blank paper band beyond a sheet-like inner
 *                          edge — the pad's border, not this sheet (rule 2)
 *
 * plus a geometry prior and a small preference for area, so that among
 * clean quads the larger wins: a sliver of desk rather than a cut. Each
 * sample is also named — what the boundary under it is, from the profile
 * kind and the colours either side (classifyBoundary) — and a side whose
 * samples confirm the sheet's own print past it makes the whole quad
 * invalid: cutting content is not a cost to trade, it is a failure. Every
 * calibration constant lives here, with the reasoning next to it. The
 * search only ever compares totals; the breakdown is for the overlay page.
 *
 * Worker-global, like every worker module.
 */
"use strict";

const SCORE = Object.freeze({
  samplesPerSide: 32,
  minValidSamples: 8,          // fewer, and the side is unobserved
  // An unobserved side (along the frame's border) is a guess, and a guess
  // must lose to any side with real support behind it, or the frame's edge
  // would win whenever a true edge is faint or partly hidden.
  unobservedEdge: 0.2,

  // Probe depths, px at 800px (scaled by shortSide / 800). A candidate's
  // side is often a few px off the edge it found, so each sample is also
  // read at small offsets across the side and the strongest reading stands:
  // refinement is what closes the gap, and it needs the edge to be seen.
  referenceShortSide: 800,
  depths: { near: 3, mid: 6, far: 10, band: 20 },
  sampleOffsets: [0, -2, 2],

  // The profile classifier. A step of 25 gray levels is full contrast — the
  // old probes' calibrated value; 9 is where paper-on-paper seams begin to
  // read at all (grid evidence's shadowMinDip); a printed rule dips 12+ with
  // the same paper on both sides.
  line: { minDip: 12, maxAcrossDifference: 9 },
  step: { min: 9, fullScale: 25 },
  shadowStep: { minDip: 9, minRemainingDrop: 6, dipWeight: 0.6, dipFullScale: 15 },

  edge: { trimmedShare: 0.75 },        // the best three quarters: a hand or a fold over the rest costs nothing
  // Inside is the desk when it is nearer the frame's border colour than the
  // sheet's paper — the desk's, not merely whatever lies outside the side: a
  // hand across an edge lies on both sides of it too, and is not the desk.
  // Nearest-of-two, so a light desk close to paper still separates from it;
  // where the two are closer than the margin the test says nothing.
  background: { maxDeltaE: 30, minDeskToPaper: 15 },
  paperOutside: { maxAcrossDifference: 12 },
  // Content is looked for from past the widest shadow a sheet casts (the
  // grid evidence measured 4px) so a dark seam never reads as print, and
  // print is dark against its own neighbours a few px away — a cast shadow
  // on a light desk is as dark, but it ramps. At this scale a blurred
  // stroke or rule is 25-60 levels below the paper beside it.
  // A stroke of 25 levels is ink beyond doubt at this scale; one of 40 on
  // the sheet's own paper (the palette's tolerance halved) with no boundary
  // between confirms it is this sheet's content, and a side with that under
  // 15% of its samples is cutting it — CUT is the maximum share of samples
  // a valid quad may have.
  content: { startDepth: 8, reachOfShortSide: 0.08, step: 2, paperGap: 5, inkContrast: 25,
             confirmedContrast: 40, ownPaperToleranceShare: 0.5, maxConfirmedShare: 0.15 },
  // The nested edge must be paper meeting paper — a seam, not a printed box
  // or the desk. The desk case is B's; a thick rule steps far harder. A thin
  // dark line with the same paper on both sides is a seam or a printed rule,
  // and at this scale the two look alike; what tells them apart is where the
  // print is — a rule sits at the table, a seam sits clear of it.
  nested: { from: 0.025, to: 0.12, step: 2, blankMagnitudeShare: 0.25, maxStep: 35, minSeamFromPrint: 0.015 },

  // Ink against the paper, in Lab (8-bit, a/b offset 128): darker by this
  // much, or coloured. What paper is (SHEET_COLOUR) is shared with the
  // legacy pipeline's sheet-colour mask.
  ink: { lightnessDrop: 60, chroma: 25 },

  geometry: {
    hardMinAngleDeg: 40, hardMaxAngleDeg: 140,
    softMinAngleDeg: 60, softMaxAngleDeg: 120, anglePenaltyPerDeg: 0.02, anglePenaltyCap: 0.4,
    maxOppositeRatio: 2.5, oppositeWeight: 0.3,
    maxAspect: 3.2, aspectWeight: 0.2,          // long receipts are allowed; wider than this is not a sheet
    minAreaFraction: 0.08, maxAreaFraction: 0.98,
  },

  weights: { edge: 1.0, background: 1.5, paperOutside: 1.2, content: 3.0, nested: 1.0, area: 0.10 },

  // Skin in 8-bit Lab (a, b offset 128): warmer than any paper the palette
  // admits. A wooden desk is as warm, so a colour nearer the desk's than the
  // paper's is the desk, whatever its hue — the grid evidence's YCrCb test
  // makes the same exception through the sheet-colour mask.
  skin: { minA: 136, minB: 134, minChroma: 14, maxL: 230 },
});

// What the boundary under a sample is, from its profile kind and the
// colours either side. The score's terms and the refit's guards read these;
// the profile kinds stay the low-level input they always were.
const BOUNDARY = Object.freeze({
  DOCUMENT_EDGE: "DOCUMENT_EDGE", // paper inside, not paper outside: the sheet ends
  PAPER_SEAM: "PAPER_SEAM",       // paper both sides across a line or a step: a sheet over a sheet
  PRINTED_LINE: "PRINTED_LINE",   // a dip within the print, the same paper both sides
  SHADOW: "SHADOW",               // a dark step with nothing paper-like beyond
  DESK_EDGE: "DESK_EDGE",         // a step with neither side paper
  OCCLUDER: "OCCLUDER",           // skin beyond the side
  UNKNOWN: "UNKNOWN",             // no boundary read here
});
const EDGE_LABELS = new Set([BOUNDARY.DOCUMENT_EDGE, BOUNDARY.PAPER_SEAM, BOUNDARY.SHADOW]);

const SAMPLE_KIND_NONE = "none";
const SAMPLE_KIND_STEP = "step";
const SAMPLE_KIND_SHADOW_STEP = "shadowStep";
const SAMPLE_KIND_LINE = "line";
const SAMPLE_KIND_SEAM = "seam"; // a line-like dip clear of the print: the sheet's edge over its pad

// ------------------------------------------------------------------
// Paper and ink
// ------------------------------------------------------------------

/**
 * The colour tests, bound to one quad's paper colour — the sheet's own where
 * enough of the quad is in frame to read it, the desk's otherwise.
 */
function paletteFor(frame, quad) {
  const at = (x, y) => frameLabAt(frame, x, y);
  const paper = paperColourInside(quad, frame, at) || frame.backgroundLab;
  const { chromaTolerance, lightnessAllowance } = SHEET_COLOUR;
  const { lightnessDrop, chroma } = SCORE.ink;
  return {
    paper,
    desk: frame.backgroundLab,
    isPaper(x, y) {
      const pixel = at(x, y);
      return Math.abs(pixel.a - paper.a) <= chromaTolerance && Math.abs(pixel.b - paper.b) <= chromaTolerance &&
        pixel.l >= paper.l - lightnessAllowance;
    },
    isInk(x, y) {
      const pixel = at(x, y);
      return pixel.l <= paper.l - lightnessDrop || Math.hypot(pixel.a - paper.a, pixel.b - paper.b) >= chroma;
    },
    /** The sheet's own paper, strictly: within half the tolerance. */
    isOwnPaper(x, y) {
      const pixel = at(x, y), share = SCORE.content.ownPaperToleranceShare;
      return Math.abs(pixel.a - paper.a) <= chromaTolerance * share && Math.abs(pixel.b - paper.b) <= chromaTolerance * share &&
        Math.abs(pixel.l - paper.l) <= lightnessAllowance * share;
    },
    /** Nearer the desk's colour than the paper's — only where the two are
     *  far enough apart to tell; null when they are not. */
    isDesk(colour) {
      const desk = frame.backgroundLab;
      if (this.distance(desk, paper) < SCORE.background.minDeskToPaper) return null;
      return this.distance(colour, desk) <= SCORE.background.maxDeltaE && this.distance(colour, desk) < this.distance(colour, paper);
    },
    isSkin(colour) {
      const { minA, minB, minChroma, maxL } = SCORE.skin;
      return colour.l <= maxL && colour.a >= minA && colour.b >= minB && Math.hypot(colour.a - 128, colour.b - 128) >= minChroma &&
        this.isDesk(colour) !== true;
    },
    colourAt: at,
    distance(first, second) {
      return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
    },
    medianColour: medianLab,
  };
}

// ------------------------------------------------------------------
// The profile classifier
// ------------------------------------------------------------------

/** Probe depths for one sample, signed px along the outward normal. */
function probeDepths(scale) {
  const { near, mid, far, band } = SCORE.depths;
  return [-band, -far, -mid, -near, -1, 0, 1, near, mid, far, band].map((d) => d * scale);
}
const PROBE_INDEX = Object.freeze({ inBand: 0, inFar: 1, inMid: 2, inNear: 3, centreIn: 4, centre: 5, centreOut: 6,
                                    outNear: 7, outMid: 8, outFar: 9, outBand: 10 });

/**
 * What the gray does across the side at one sample.
 * @returns { kind, strength } — strength in 0..1 for a step or shadow step
 */
function classifyProfile(values) {
  const p = PROBE_INDEX;
  const inner = median([values[p.inFar], values[p.inMid], values[p.inNear]].sort(ascending));
  const outer = median([values[p.outNear], values[p.outMid], values[p.outFar]].sort(ascending));
  const centre = Math.min(values[p.centreIn], values[p.centre], values[p.centreOut]);
  const step = outer - inner;
  const dip = Math.min(inner, outer) - centre;
  const acrossDifference = Math.abs(values[p.outFar] - values[p.inFar]);
  const { minDip, minRemainingDrop, dipWeight, dipFullScale } = SCORE.shadowStep;
  const dipStrength = dip >= minDip ? dipWeight * Math.min(1, dip / dipFullScale) : 0;
  if (dip >= SCORE.line.minDip && acrossDifference < SCORE.line.maxAcrossDifference) {
    return { kind: SAMPLE_KIND_LINE, strength: 0, dipStrength, step, inner, outer };
  }
  const stepStrength = Math.abs(step) >= SCORE.step.min ? Math.min(1, Math.abs(step) / SCORE.step.fullScale) : 0;
  // The seam of a sheet on its pad: a dark line, and the far side stays a
  // little darker than the near side once it has recovered.
  const isShadowStep = dip >= minDip && Math.abs(step) >= minRemainingDrop;
  if (!stepStrength && !isShadowStep) return { kind: SAMPLE_KIND_NONE, strength: 0, dipStrength, step, inner, outer };
  return {
    kind: isShadowStep && !stepStrength ? SAMPLE_KIND_SHADOW_STEP : SAMPLE_KIND_STEP,
    strength: Math.max(stepStrength, dipStrength),
    dipStrength, step, inner, outer,
  };
}

/**
 * A printed rule and a sheet's seam over its pad look alike across the
 * side — a thin dark line with the same paper on both sides — and at this
 * scale their depths overlap. Where the print is tells them apart: a rule
 * sits at the table, a seam sits clear of it. Reclassifies a line as a seam
 * when it lies outside the print by the margin.
 */
function classifyAt(frame, point, normal, depths, type) {
  const values = profileAcross(frame, point, normal, depths);
  if (!values) return null;
  const profile = classifyProfile(values);
  if (profile.kind === SAMPLE_KIND_LINE && frame.printExtent &&
      distanceOutsidePrint(point, type, frame.printExtent) >= SCORE.nested.minSeamFromPrint * frame.shortSide) {
    profile.kind = SAMPLE_KIND_SEAM;
    profile.strength = profile.dipStrength;
  }
  profile.values = values;
  return profile;
}

function isBoundaryKind(kind) {
  return kind === SAMPLE_KIND_STEP || kind === SAMPLE_KIND_SHADOW_STEP || kind === SAMPLE_KIND_SEAM;
}

// ------------------------------------------------------------------
// One side
// ------------------------------------------------------------------

/** Everything read at one sample point, before the terms are drawn. */
function readSample(frame, centre, normal, depths, palette, scale, type) {
  let point = centre, profile = null;
  for (const offset of SCORE.sampleOffsets) {
    const candidate = { x: centre.x + normal.nx * offset * scale, y: centre.y + normal.ny * offset * scale };
    const read = classifyAt(frame, candidate, normal, depths, type);
    if (!read) { if (offset === 0) return null; continue; }
    if (!profile || read.strength > profile.strength) { profile = read; point = candidate; }
  }
  const { kind, strength, values } = profile;
  const edge = strength * gradientAcrossNear(frame, point, normal, depths[PROBE_INDEX.outNear]);
  const p = PROBE_INDEX;
  const pixelAt = (depth) => alongNormal(point, normal, depth);
  const outBand = pixelAt(depths[p.outBand]);
  return {
    point, values, kind, edge,
    inFar: pixelAt(depths[p.inFar]), inBand: pixelAt(depths[p.inBand]),
    outFar: pixelAt(depths[p.outFar]), outBand,
    outsideColour: palette.colourAt(outBand.x, outBand.y),
    acrossBands: Math.abs(values[p.outBand] - values[p.inBand]),
    scale,
  };
}

/** The strongest across-the-side gradient direction within `reach` px of
 *  the sample: the step the classifier saw may sit a few px off the side,
 *  and refinement is what moves the side onto it. */
function gradientAcrossNear(frame, point, normal, reach) {
  let best = 0;
  for (let depth = -reach; depth <= reach; depth++) {
    const { x, y } = alongNormal(point, normal, depth);
    if (insideBounds(frame, x, y)) best = Math.max(best, gradientAcross(frame, x, y, normal));
  }
  return best;
}

/** Print just outside a side, on paper that runs unbroken from the side to
 *  it: ink between paper-like pixels, marching outward over paper only. A
 *  neighbouring sheet's print does not count — the desk or shadow between
 *  the sheets stops the march — and wood grain is dark on wood, not ink on
 *  paper. A seam's shadow is thinner than the start.
 *  @returns null without ink, else { depth, confirmed } — confirmed when the
 *           stroke is unmistakable, the paper walked over was the sheet's
 *           own throughout, and no boundary was read at the side: this
 *           sheet's content, which the side is cutting */
function contentOutside(frame, sample, normal, palette) {
  const { startDepth, reachOfShortSide, step, paperGap, inkContrast, confirmedContrast } = SCORE.content;
  const reach = reachOfShortSide * frame.shortSide;
  const at = (depth) => alongNormal(sample.point, normal, depth);
  let ownPaper = !EDGE_LABELS.has(sample.label) && sample.label !== BOUNDARY.DESK_EDGE;
  for (let depth = startDepth * sample.scale; depth <= reach; depth += step) {
    const pixel = at(depth), before = at(depth - paperGap), after = at(depth + paperGap);
    if (!insideBounds(frame, after.x, after.y) || !insideBounds(frame, before.x, before.y)) return null;
    const neighbours = Math.min(frameGrayAt(frame, before.x, before.y), frameGrayAt(frame, after.x, after.y));
    const contrast = neighbours - frameGrayAt(frame, pixel.x, pixel.y);
    if (contrast >= inkContrast) {
      if (!palette.isPaper(before.x, before.y) || !palette.isPaper(after.x, after.y)) return null; // dark, but not print on paper: the paper has ended
      return { depth, confirmed: ownPaper && contrast >= confirmedContrast && palette.isOwnPaper(before.x, before.y) };
    }
    if (!palette.isPaper(pixel.x, pixel.y)) return null;
    if (ownPaper && !palette.isOwnPaper(pixel.x, pixel.y)) ownPaper = false;
  }
  return null;
}

/**
 * What the boundary under a sample is. The profile kind says what the gray
 * does across the side; the colours either side say what the two sides are.
 */
function classifyBoundary(sample, palette) {
  const { kind, inFar, outFar, outBand } = sample;
  const outsideColour = palette.colourAt(outBand.x, outBand.y);
  if (palette.isSkin(outsideColour)) return BOUNDARY.OCCLUDER;
  if (kind === SAMPLE_KIND_LINE) return BOUNDARY.PRINTED_LINE;
  if (kind === SAMPLE_KIND_SEAM) return BOUNDARY.PAPER_SEAM;
  if (kind === SAMPLE_KIND_NONE) return BOUNDARY.UNKNOWN;
  const insidePaper = palette.isPaper(inFar.x, inFar.y);
  const outsidePaper = palette.isPaper(outFar.x, outFar.y) && palette.isPaper(outBand.x, outBand.y);
  if (insidePaper && outsidePaper) return BOUNDARY.PAPER_SEAM;
  if (insidePaper) return kind === SAMPLE_KIND_SHADOW_STEP && palette.isDesk(outsideColour) === false ? BOUNDARY.SHADOW : BOUNDARY.DOCUMENT_EDGE;
  return outsidePaper ? BOUNDARY.UNKNOWN : BOUNDARY.DESK_EDGE;
}

/** How far a point lies outside the print on the side's outward axis. */
function distanceOutsidePrint(point, type, extent) {
  switch (type) {
    case SIDE_TOP: return extent.top - point.y;
    case SIDE_RIGHT: return point.x - extent.right;
    case SIDE_BOTTOM: return point.y - extent.bottom;
    default: return extent.left - point.x;
  }
}

/** A sheet-like edge parallel to the side, inside it, with a blank paper
 *  band between: the band is a pad's border or a neighbour, not this sheet.
 *  A printed rule (kind line) never counts, and neither does a band that is
 *  not paper (a banner) or an inner edge whose far side is not paper. */
function nestedBoundary(frame, sample, normal, depths, palette, type) {
  const { from, to, step, blankMagnitudeShare } = SCORE.nested;
  const inward = { nx: -normal.nx, ny: -normal.ny };
  const start = from * frame.shortSide, end = to * frame.shortSide;
  for (let depth = start; depth <= end; depth += step) {
    const inner = { x: sample.point.x + inward.nx * depth, y: sample.point.y + inward.ny * depth };
    const profile = classifyAt(frame, inner, normal, depths, type);
    if (!profile) return false;
    const { kind, step: innerStep, inner: innerGray } = profile;
    if (!isBoundaryKind(kind)) continue;
    const paperMeetsPaper = Math.abs(innerStep) <= SCORE.nested.maxStep &&
      innerGray >= palette.paper.l - SCORE.ink.lightnessDrop;
    if (!paperMeetsPaper) return false;
    const beyond = alongNormal(inner, inward, SCORE.depths.far * sample.scale);
    if (!insideBounds(frame, beyond.x, beyond.y) || !palette.isPaper(beyond.x, beyond.y)) return false;
    return bandIsBlankPaper(frame, sample, inward, SCORE.depths.near * sample.scale, depth - SCORE.depths.near * sample.scale, palette, blankMagnitudeShare);
  }
  return false;
}

function bandIsBlankPaper(frame, sample, inward, fromDepth, toDepth, palette, blankMagnitudeShare) {
  if (toDepth <= fromDepth) return false;
  let magnitudeSum = 0, count = 0;
  for (let depth = fromDepth; depth <= toDepth; depth += SCORE.nested.step) {
    const { x, y } = alongNormal(sample.point, inward, depth);
    if (!insideBounds(frame, x, y) || !palette.isPaper(x, y) || palette.isInk(x, y)) return false;
    magnitudeSum += frameMagnitudeAt(frame, x, y);
    count++;
  }
  return count > 0 && magnitudeSum / count < blankMagnitudeShare * frame.magnitudeScale;
}

/** Whether the pixels just inside the side belong to the desk. */
function insideIsDesk(sample, palette, outside) {
  const inFar = palette.colourAt(sample.inFar.x, sample.inFar.y);
  const inBand = palette.colourAt(sample.inBand.x, sample.inBand.y);
  const nearerDesk = palette.isDesk(inFar);
  if (nearerDesk !== null) return nearerDesk && palette.isDesk(inBand);
  return !palette.isPaper(sample.inFar.x, sample.inFar.y) && !palette.isPaper(sample.inBand.x, sample.inBand.y) &&
    palette.distance(inBand, outside) <= SCORE.background.maxDeltaE;
}

/**
 * The five terms for one side of `quad`, what its samples were read as, and
 * what it is cutting.
 * @returns { edge, background, paperOutside, content, nested, confirmedContent,
 *            contentDepth, labels, valid, unobserved, samples } — labels is the
 *          share of samples under each BOUNDARY label; confirmedContent the
 *          share with this sheet's own print past the side, contentDepth how
 *          far past it (px) the farthest of it lies; samples only when
 *          `options.keepSamples`, for the page
 */
function scoreSide(frame, quad, type, palette, options) {
  const side = sideOf(quad, type);
  const normal = outwardNormal(quad, side);
  const scale = frame.scale;
  const depths = probeDepths(scale);
  const samples = [];
  for (let i = 0; i < SCORE.samplesPerSide; i++) {
    const sample = readSample(frame, pointAlong(side.a, side.b, (i + 0.5) / SCORE.samplesPerSide), normal, depths, palette, scale, type);
    if (sample) samples.push(sample);
  }
  for (const sample of samples) sample.label = classifyBoundary(sample, palette);
  const result = { edge: SCORE.unobservedEdge, background: 0, paperOutside: 0, content: 0, nested: 0,
                   confirmedContent: 0, contentDepth: 0, labels: {},
                   valid: samples.length, unobserved: samples.length < SCORE.minValidSamples,
                   samples: options && options.keepSamples ? samples.map(({ kind, label, values }) => ({ kind, label, values })) : undefined };
  for (const sample of samples) result.labels[sample.label] = (result.labels[sample.label] || 0) + 1 / samples.length;
  if (result.unobserved) return result;

  const outside = palette.medianColour(samples.map((s) => s.outsideColour));
  let background = 0, paperOutside = 0, content = 0, confirmed = 0, nested = 0;
  for (const sample of samples) {
    const noBoundary = !isBoundaryKind(sample.kind);
    if (insideIsDesk(sample, palette, outside)) background++;
    if (noBoundary && palette.isPaper(sample.outFar.x, sample.outFar.y) && palette.isPaper(sample.outBand.x, sample.outBand.y) &&
        sample.acrossBands < SCORE.paperOutside.maxAcrossDifference) paperOutside++;
    const ink = contentOutside(frame, sample, normal, palette);
    if (ink) {
      content++;
      if (ink.confirmed) { confirmed++; result.contentDepth = Math.max(result.contentDepth, ink.depth); }
    }
    if (!(options && options.withoutNested) && nestedBoundary(frame, sample, normal, depths, palette, type)) nested++;
  }
  const edges = samples.map((s) => s.edge).sort((a, b) => b - a);
  const kept = edges.slice(0, Math.max(1, Math.round(edges.length * SCORE.edge.trimmedShare)));
  result.edge = kept.reduce((sum, e) => sum + e, 0) / kept.length;
  result.background = background / samples.length;
  result.paperOutside = paperOutside / samples.length;
  result.content = content / samples.length;
  result.confirmedContent = confirmed / samples.length;
  result.nested = nested / samples.length;
  return result;
}

/** How far a side can be trusted to be the sheet's edge, 0..1: an edge
 *  under it, read as an edge, with nothing of the sheet beyond it. Looseness
 *  (desk inside) is not counted against it — a loose side is a safe one. A
 *  side at or past the frame's border cannot be read and cannot cut: half. */
function sideConfidence(side) {
  if (side.unobserved) return 0.5;
  const edgeLabels = Object.entries(side.labels).reduce((sum, [label, share]) => sum + (EDGE_LABELS.has(label) ? share : 0), 0);
  return clamp(side.edge, 0, 1) * (0.5 + 0.5 * edgeLabels) * (1 - side.content) * (1 - side.confirmedContent);
}

/** The quad's confidence, 0..1: its weakest side, discounted for an odd
 *  shape — and the sides', with a word for each weak one.
 *  @returns { overall, sides: [4], warnings: ["left: unobserved", ...] } */
function quadConfidence(score) {
  if (!score.sides.length) return { overall: 0, sides: [0, 0, 0, 0], warnings: [score.rejected] };
  const sides = score.sides.map(sideConfidence);
  const warnings = [];
  score.sides.forEach((side, type) => { const why = sideWarning(side); if (why) warnings.push(`${SIDE_NAMES[type]}: ${why}`); });
  return { overall: +(Math.min(...sides) * Math.max(0, 1 - score.geometry)).toFixed(3), sides: sides.map((c) => +c.toFixed(3)), warnings };
}

/** Why a side is weak, in a word, or null when it is not. */
function sideWarning(side) {
  if (side.unobserved) return "unobserved";
  if (side.confirmedContent > 0) return "content beyond";
  if (side.background > 0.5) return "desk inside";
  if ((side.labels[BOUNDARY.PRINTED_LINE] || 0) > 0.5) return "printed line";
  if ((side.labels[BOUNDARY.OCCLUDER] || 0) > 0.5) return "occluded";
  if (side.edge < 0.3) return "weak edge";
  return null;
}

// ------------------------------------------------------------------
// Geometry and the total
// ------------------------------------------------------------------

/** Why a quad cannot be a sheet at all, or null. */
function geometryRejection(quad, frame) {
  const g = SCORE.geometry;
  if (outOfBounds(quadPoints(quad), frame, OUT_OF_FRAME_TOLERANCE)) return "outOfFrame";
  if (!isConvex(quad)) return "concave";
  const angles = internalAngles(quad);
  if (angles.some((angle) => angle < g.hardMinAngleDeg || angle > g.hardMaxAngleDeg)) return "angle";
  const areaFraction = shoelaceArea(quad) / (frame.width * frame.height);
  if (areaFraction < g.minAreaFraction || areaFraction > g.maxAreaFraction) return "area";
  return null;
}

function isConvex(quad) {
  const points = quadPoints(quad);
  let sign = 0;
  for (let i = 0; i < SIDE_COUNT; i++) {
    const a = points[i], b = points[(i + 1) % SIDE_COUNT], c = points[(i + 2) % SIDE_COUNT];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return sign !== 0;
}

/** Soft penalties for a shape that is a sheet, but an odd one. */
function geometryPenalty(quad) {
  const g = SCORE.geometry;
  let penalty = 0;
  for (const angle of internalAngles(quad)) {
    const outside = Math.max(0, g.softMinAngleDeg - angle, angle - g.softMaxAngleDeg);
    penalty += Math.min(g.anglePenaltyCap, outside * g.anglePenaltyPerDeg);
  }
  const { opposite, aspect } = sideRatios(quad);
  penalty += g.oppositeWeight * Math.max(0, opposite - g.maxOppositeRatio);
  penalty += g.aspectWeight * Math.max(0, aspect - g.maxAspect);
  return penalty;
}

/**
 * The score of one quad, with its breakdown.
 * @param options { keepSamples, withoutNested, palette, reuseSides }
 *                — withoutNested skips the inward march, the costliest term,
 *                for a search's trial moves; the verdict on a quad always
 *                includes it. `palette` and `reuseSides` (side scores by
 *                type, null to re-score) let a search that moved one side
 *                re-read that side alone.
 * @returns { total, rejected, geometry, area, sides: [4 × side terms] } —
 *          rejected "cuts" (total -Infinity, sides kept) when a side has the
 *          sheet's own print past it on more than the allowed share
 */
function scoreQuad(frame, quad, options) {
  const rejected = geometryRejection(quad, frame);
  if (rejected) return { total: -Infinity, rejected, geometry: 0, area: 0, sides: [] };
  const palette = (options && options.palette) || paletteFor(frame, quad);
  const reuse = options && options.reuseSides;
  const sides = [];
  for (let type = 0; type < SIDE_COUNT; type++) {
    sides.push(reuse && reuse[type] ? reuse[type] : scoreSide(frame, quad, type, palette, options));
  }
  const geometry = geometryPenalty(quad);
  const area = shoelaceArea(quad) / (frame.width * frame.height);
  const cuts = sides.some((side) => side.confirmedContent > SCORE.content.maxConfirmedShare);
  return { total: cuts ? -Infinity : totalOf(sides, geometry, area), rejected: cuts ? "cuts" : null, geometry, area, sides, paper: palette.paper };
}

function totalOf(sides, geometry, area) {
  const w = SCORE.weights;
  let sum = 0;
  for (const side of sides) {
    sum += w.edge * side.edge - w.background * side.background - w.paperOutside * side.paperOutside -
           w.content * side.content - w.nested * side.nested;
  }
  return sum / sides.length - geometry + w.area * Math.sqrt(area);
}
