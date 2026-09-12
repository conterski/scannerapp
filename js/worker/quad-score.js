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
 * clean quads the larger wins: a sliver of desk rather than a cut. Every
 * calibration constant lives here, with the reasoning next to it. The
 * search only ever compares totals; the breakdown is for the overlay page.
 *
 * Worker-global, like every worker module.
 */

const SCORE = Object.freeze({
  samplesPerSide: 32,
  previewSamplesPerSide: 20,
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
  content: { startDepth: 8, reachOfShortSide: 0.08, step: 2, paperGap: 5, inkContrast: 25 },
  // The nested edge must be paper meeting paper — a seam, not a printed box
  // or the desk. The desk case is B's; a thick rule steps far harder. A thin
  // dark line with the same paper on both sides is a seam or a printed rule,
  // and at this scale the two look alike; what tells them apart is where the
  // print is — a rule sits at the table, a seam sits clear of it.
  nested: { from: 0.025, to: 0.12, step: 2, blankMagnitudeShare: 0.25, maxStep: 35, minSeamFromPrint: 0.015 },

  // Paper and ink in Lab (8-bit, a/b offset 128). The chroma tolerance and
  // lightness allowance are the sheet-colour mask's calibrated values: a
  // sheet shades across its own surface but keeps its hue.
  paper: { chromaTolerance: 12, lightnessAllowance: 70, inkLightnessDrop: 60, inkChroma: 25,
           samplesPerAxis: 7, inset: 0.1, brightestShare: 0.6 },

  geometry: {
    hardMinAngleDeg: 40, hardMaxAngleDeg: 140,
    softMinAngleDeg: 60, softMaxAngleDeg: 120, anglePenaltyPerDeg: 0.02, anglePenaltyCap: 0.4,
    maxOppositeRatio: 2.5, oppositeWeight: 0.3,
    maxAspect: 3.2, aspectWeight: 0.2,          // long receipts are allowed; wider than this is not a sheet
    minAreaFraction: 0.08, maxAreaFraction: 0.98,
    outOfFrameTolerance: 0.15,
  },

  weights: { edge: 1.0, background: 1.5, paperOutside: 1.2, content: 3.0, nested: 1.0, area: 0.10 },
});

const SAMPLE_KIND_NONE = "none";
const SAMPLE_KIND_STEP = "step";
const SAMPLE_KIND_SHADOW_STEP = "shadowStep";
const SAMPLE_KIND_LINE = "line";
const SAMPLE_KIND_SEAM = "seam"; // a line-like dip clear of the print: the sheet's edge over its pad

// ------------------------------------------------------------------
// Paper and ink
// ------------------------------------------------------------------

/**
 * The colour tests, bound to one quad's paper colour. Lab when the frame has
 * it; gray proxies for the preview, which skips Lab for speed.
 */
function paletteFor(frame, quad) {
  if (frame.lab) {
    const paper = paperLabInside(frame, quad) || frame.backgroundLab;
    return labPalette(frame, paper);
  }
  return grayPalette(frame, paperGrayInside(frame, quad));
}

function labPalette(frame, paper) {
  const { chromaTolerance, lightnessAllowance, inkLightnessDrop, inkChroma } = SCORE.paper;
  const at = (x, y) => frameLabAt(frame, x, y);
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
      return pixel.l <= paper.l - inkLightnessDrop || Math.hypot(pixel.a - paper.a, pixel.b - paper.b) >= inkChroma;
    },
    colourAt: at,
    distance(first, second) {
      return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
    },
    medianColour(colours) {
      const channel = (key) => median(colours.map((c) => c[key]).sort(ascending));
      return { l: channel("l"), a: channel("a"), b: channel("b") };
    },
  };
}

function grayPalette(frame, paperGray) {
  const { lightnessAllowance, inkLightnessDrop } = SCORE.paper;
  return {
    paper: { l: paperGray },
    desk: null, // the preview reads no colour; the side's own outside stands in
    isPaper: (x, y) => frameGrayAt(frame, x, y) >= paperGray - lightnessAllowance,
    isInk: (x, y) => frameGrayAt(frame, x, y) <= paperGray - inkLightnessDrop,
    colourAt: (x, y) => ({ l: frameGrayAt(frame, x, y) }),
    distance: (first, second) => Math.abs(first.l - second.l),
    medianColour: (colours) => ({ l: median(colours.map((c) => c.l).sort(ascending)) }),
  };
}

/** Bilinear point inside a quad at (u, v) in 0..1. */
function pointWithinQuad({ tl, tr, br, bl }, u, v) {
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

/** The interior on a grid, inset from the sides, as pixel coordinates. */
function interiorSamplePoints(frame, quad) {
  const { samplesPerAxis: n, inset } = SCORE.paper;
  const points = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const point = pointWithinQuad(quad, inset + (1 - 2 * inset) * (i + 0.5) / n, inset + (1 - 2 * inset) * (j + 0.5) / n);
      const x = Math.round(point.x), y = Math.round(point.y);
      if (insideFrame(frame, x, y)) points.push({ x, y });
    }
  }
  return points;
}

/** The paper's Lab: the median of the brightest share of interior samples, so
 *  ink and rulings do not vote. Null when too little of the quad is in frame. */
function paperLabInside(frame, quad) {
  const points = interiorSamplePoints(frame, quad);
  if (points.length < SCORE.paper.samplesPerAxis) return null;
  const samples = points.map(({ x, y }) => frameLabAt(frame, x, y)).sort((p, q) => q.l - p.l);
  const brightest = samples.slice(0, Math.max(1, Math.round(samples.length * SCORE.paper.brightestShare)));
  const channel = (key) => median(brightest.map((s) => s[key]).sort(ascending));
  return { l: channel("l"), a: channel("a"), b: channel("b") };
}

function paperGrayInside(frame, quad) {
  const values = interiorSamplePoints(frame, quad).map(({ x, y }) => frameGrayAt(frame, x, y)).sort((a, b) => b - a);
  if (!values.length) return 200;
  return median(values.slice(0, Math.max(1, Math.round(values.length * SCORE.paper.brightestShare))).sort(ascending));
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
  const pixelAt = (depth) => ({ x: Math.round(point.x + normal.nx * depth), y: Math.round(point.y + normal.ny * depth) });
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
    const x = Math.round(point.x + normal.nx * depth), y = Math.round(point.y + normal.ny * depth);
    if (insideFrame(frame, x, y)) best = Math.max(best, gradientAcross(frame, x, y, normal));
  }
  return best;
}

/** Print just outside a side, on paper that runs unbroken from the side to
 *  it: ink between paper-like pixels, marching outward over paper only. A
 *  neighbouring sheet's print does not count — the desk or shadow between
 *  the sheets stops the march — and wood grain is dark on wood, not ink on
 *  paper. A seam's shadow is thinner than the start. */
function contentOutside(frame, sample, normal, palette) {
  const { startDepth, reachOfShortSide, step, paperGap, inkContrast } = SCORE.content;
  const reach = reachOfShortSide * frame.shortSide;
  const at = (depth) => ({ x: Math.round(sample.point.x + normal.nx * depth), y: Math.round(sample.point.y + normal.ny * depth) });
  for (let depth = startDepth * sample.scale; depth <= reach; depth += step) {
    const pixel = at(depth), before = at(depth - paperGap), after = at(depth + paperGap);
    if (!insideFrame(frame, after.x, after.y) || !insideFrame(frame, before.x, before.y)) return false;
    const neighbours = Math.min(frameGrayAt(frame, before.x, before.y), frameGrayAt(frame, after.x, after.y));
    const isStroke = frameGrayAt(frame, pixel.x, pixel.y) <= neighbours - inkContrast;
    if (isStroke) {
      if (palette.isPaper(before.x, before.y) && palette.isPaper(after.x, after.y)) return true;
      return false; // dark, but not print on paper: the paper has ended
    }
    if (!palette.isPaper(pixel.x, pixel.y)) return false;
  }
  return false;
}

/** A sheet-like edge parallel to the side, inside it, with a blank paper
 *  band between: the band is a pad's border or a neighbour, not this sheet.
 *  A printed rule (kind line) never counts, and neither does a band that is
 *  not paper (a banner) or an inner edge whose far side is not paper. */
/** How far a point lies outside the print on the side's outward axis. */
function distanceOutsidePrint(point, type, extent) {
  switch (type) {
    case SIDE_TOP: return extent.top - point.y;
    case SIDE_RIGHT: return point.x - extent.right;
    case SIDE_BOTTOM: return point.y - extent.bottom;
    default: return extent.left - point.x;
  }
}

function nestedBoundary(frame, sample, normal, depths, palette, type) {
  const { from, to, step, blankMagnitudeShare } = SCORE.nested;
  const inward = { nx: -normal.nx, ny: -normal.ny };
  const at = (depth) => ({ x: sample.point.x + inward.nx * depth, y: sample.point.y + inward.ny * depth });
  const start = from * frame.shortSide, end = to * frame.shortSide;
  for (let depth = start; depth <= end; depth += step) {
    const inner = at(depth);
    const profile = classifyAt(frame, inner, normal, depths, type);
    if (!profile) return false;
    const { kind, step: innerStep, inner: innerGray } = profile;
    if (!isBoundaryKind(kind)) continue;
    sample.nestedAt = { depth: Math.round(depth), kind, step: innerStep }; // for the overlay page
    const paperMeetsPaper = Math.abs(innerStep) <= SCORE.nested.maxStep &&
      innerGray >= palette.paper.l - SCORE.paper.inkLightnessDrop;
    if (!paperMeetsPaper) return false;
    const beyond = { x: Math.round(inner.x + inward.nx * SCORE.depths.far * sample.scale),
                     y: Math.round(inner.y + inward.ny * SCORE.depths.far * sample.scale) };
    if (!insideFrame(frame, beyond.x, beyond.y) || !palette.isPaper(beyond.x, beyond.y)) return false;
    const nested = bandIsBlankPaper(frame, sample, inward, SCORE.depths.near * sample.scale, depth - SCORE.depths.near * sample.scale, palette, blankMagnitudeShare);
    sample.nestedAt.counted = nested;
    return nested;
  }
  return false;
}

function bandIsBlankPaper(frame, sample, inward, fromDepth, toDepth, palette, blankMagnitudeShare) {
  if (toDepth <= fromDepth) return false;
  let magnitudeSum = 0, count = 0;
  for (let depth = fromDepth; depth <= toDepth; depth += SCORE.nested.step) {
    const x = Math.round(sample.point.x + inward.nx * depth), y = Math.round(sample.point.y + inward.ny * depth);
    if (!insideFrame(frame, x, y) || !palette.isPaper(x, y) || palette.isInk(x, y)) return false;
    magnitudeSum += frameMagnitudeAt(frame, x, y);
    count++;
  }
  return count > 0 && magnitudeSum / count < blankMagnitudeShare * frame.magnitudeScale;
}

/** Whether the pixels just inside the side belong to the desk. */
function insideIsDesk(sample, palette, outside) {
  const { maxDeltaE, minDeskToPaper } = SCORE.background;
  const inFar = palette.colourAt(sample.inFar.x, sample.inFar.y);
  const inBand = palette.colourAt(sample.inBand.x, sample.inBand.y);
  const desk = palette.desk;
  if (desk && palette.distance(desk, palette.paper) >= minDeskToPaper) {
    const nearerDesk = (colour) => palette.distance(colour, desk) <= maxDeltaE &&
      palette.distance(colour, desk) < palette.distance(colour, palette.paper);
    return nearerDesk(inFar) && nearerDesk(inBand);
  }
  return !palette.isPaper(sample.inFar.x, sample.inFar.y) && !palette.isPaper(sample.inBand.x, sample.inBand.y) &&
    palette.distance(inBand, outside) <= maxDeltaE;
}

/**
 * The five terms for one side of `quad`.
 * @returns { edge, background, paperOutside, content, nested, valid, unobserved,
 *            samples } — samples only when `options.keepSamples`, for the page
 */
function scoreSide(frame, quad, type, palette, options) {
  const side = sideOf(quad, type);
  const normal = outwardNormal(quad, side);
  const scale = frame.shortSide / SCORE.referenceShortSide;
  const depths = probeDepths(scale);
  const count = options && options.preview ? SCORE.previewSamplesPerSide : SCORE.samplesPerSide;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const sample = readSample(frame, pointAlong(side.a, side.b, (i + 0.5) / count), normal, depths, palette, scale, type);
    if (sample) samples.push(sample);
  }
  const result = { edge: SCORE.unobservedEdge, background: 0, paperOutside: 0, content: 0, nested: 0,
                   valid: samples.length, unobserved: samples.length < SCORE.minValidSamples,
                   samples: options && options.keepSamples ? samples : undefined };
  if (result.unobserved) return result;

  const outside = palette.medianColour(samples.map((s) => s.outsideColour));
  let background = 0, paperOutside = 0, content = 0, nested = 0;
  for (const sample of samples) {
    const noBoundary = !isBoundaryKind(sample.kind);
    if (insideIsDesk(sample, palette, outside)) { background++; sample.desk = true; }
    sample.inside = palette.colourAt(sample.inBand.x, sample.inBand.y); // for the overlay page
    if (noBoundary && palette.isPaper(sample.outFar.x, sample.outFar.y) && palette.isPaper(sample.outBand.x, sample.outBand.y) &&
        sample.acrossBands < SCORE.paperOutside.maxAcrossDifference) paperOutside++;
    if (contentOutside(frame, sample, normal, palette)) content++;
    if (!(options && options.withoutNested) && nestedBoundary(frame, sample, normal, depths, palette, type)) nested++;
  }
  const edges = samples.map((s) => s.edge).sort((a, b) => b - a);
  const kept = edges.slice(0, Math.max(1, Math.round(edges.length * SCORE.edge.trimmedShare)));
  result.edge = kept.reduce((sum, e) => sum + e, 0) / kept.length;
  result.background = background / samples.length;
  result.paperOutside = paperOutside / samples.length;
  result.content = content / samples.length;
  result.nested = nested / samples.length;
  return result;
}

// ------------------------------------------------------------------
// Geometry and the total
// ------------------------------------------------------------------

/** Why a quad cannot be a sheet at all, or null. */
function geometryRejection(quad, frame) {
  const g = SCORE.geometry;
  const tolerance = g.outOfFrameTolerance;
  for (const point of quadPoints(quad)) {
    if (point.x < -tolerance * frame.width || point.x > (1 + tolerance) * frame.width ||
        point.y < -tolerance * frame.height || point.y > (1 + tolerance) * frame.height) return "outOfFrame";
  }
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
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
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
  const length = (type) => { const s = sideOf(quad, type); return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y); };
  const ratio = (first, second) => Math.max(first, second) / Math.max(1e-6, Math.min(first, second));
  const top = length(SIDE_TOP), bottom = length(SIDE_BOTTOM), left = length(SIDE_LEFT), right = length(SIDE_RIGHT);
  penalty += g.oppositeWeight * Math.max(0, Math.max(ratio(top, bottom), ratio(left, right)) - g.maxOppositeRatio);
  const aspect = ratio((top + bottom) / 2, (left + right) / 2);
  penalty += g.aspectWeight * Math.max(0, aspect - g.maxAspect);
  return penalty;
}

/**
 * The score of one quad, with its breakdown.
 * @param options { preview, keepSamples, withoutNested, palette, reuseSides }
 *                — withoutNested skips the inward march, the costliest term,
 *                for a search's trial moves; the verdict on a quad always
 *                includes it. `palette` and `reuseSides` (side scores by
 *                type, null to re-score) let a search that moved one side
 *                re-read that side alone.
 * @returns { total, rejected, geometry, area, sides: [4 × side terms] }
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
  return { total: totalOf(sides, geometry, area), rejected: null, geometry, area, sides, paper: palette.paper };
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
