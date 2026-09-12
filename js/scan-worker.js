/* scan-worker.js — runs OpenCV.js off the main thread: document detection and
 * its perspective warp, the capture-time denoise, and the quick look the live
 * viewfinder outline is drawn from.
 *
 * Protocol: postMessage({id, type, ...}) → postMessage({id, ok, ...})
 *   init        → loads OpenCV
 *   detect      {width, height, buffer}                      → {corners|null}
 *   previewQuad {width, height, buffer}                      → {corners|null}
 *   warp        {width, height, buffer, corners, dstW, dstH} → {buffer}
 *   denoise     {width, height, buffer}                      → {buffer}
 *
 * The detector itself lives in worker/: geometry (pure math), pixel-probes
 * (what the pixels say), candidates (mask → scored quads), edge-fusion
 * (assembling the best four sides), quad-refine (the anti-cut passes) and
 * grid-evidence (the printed grid as proof of where a sheet on a pad ends).
 * This file owns the pipeline that runs them in order.
 */
"use strict";

// Carried across from the page on this worker's own URL (see detect.js).
// These modules share one scope, so a half-stale set would fail as a
// ReferenceError mid-detection; stamping them keeps the set consistent.
const ASSET_VERSION = self.location.search;

importScripts(...[
  "worker/geometry.js",
  "worker/pixel-probes.js",
  "worker/candidates.js",
  "worker/edge-fusion.js",
  "worker/quad-refine.js",
  "worker/grid-evidence.js",
  "worker/guided-filter.js",
  "worker/enhance.js",
].map((path) => path + ASSET_VERSION));

// Morphology: an aggressive OPEN severs thin bright bridges between the paper
// and adjacent objects (other papers, glare) so blobs don't merge. Sized for
// the ~800px frame detection runs at.
const DETECT_KERNELS = { open: 13, close: 7, dilate: 7 };

// The live viewfinder outline runs the same masks at ~400px, so its kernels
// are scaled to match — the detection sizes would swallow a page at that
// scale. This is a quick look for framing, not the crop.
const PREVIEW_KERNELS = { open: 7, close: 3, dilate: 3 };

const BLUR_KERNEL_SIZE = 5;

// Local adaptive threshold: survives shadow gradients across the paper.
const ADAPTIVE_BLOCK_DIVISOR = 6;
const ADAPTIVE_CONSTANT = -4;

const CANNY_LOW = 50, CANNY_HIGH = 150;
const CANNY_SOFT_LOW = 25, CANNY_SOFT_HIGH = 80;

// Straight segments harvested before dilation, used as outward-only side
// extensions when no mask isolates a full quad.
const HOUGH_THRESHOLD = 50;
const HOUGH_MIN_LENGTH_FRACTION = 0.12;
const HOUGH_MAX_GAP = 10;
const MAX_HOUGH_SEGMENTS = 80;

// Reuniting a severed document section.
const REUNITE_MIN_AREA_RATIO = 1.25;
const REUNITE_MIN_SCORE = 0.45;
const REUNITE_MAX_OUTSIDE = 0.12;
const REUNITE_LOCK_MARGIN_FRACTION = 0.04;
const REUNITE_MAX_OUT_OF_FRAME = 0.15;

// Preferring a safe split part over the merged blob it came from.
const SAFE_OVERRIDE_MIN_BBOX_IOU = 0.6;
const SAFE_OVERRIDE_MIN_SCORE_RATIO = 0.5;

// Hull-cut safety net. Calibrated on the full test set: legitimate fusion
// pull-ins (trimming blob overshoot) measure <= 0.072 of hull area, while
// content cuts (an interior table line winning a side) measure >= 0.104. A
// false positive only loosens the crop, which is the accepted bias.
const HULL_CUT_THRESHOLD = 0.09;

// The sheet's own colour, sampled inside its printed grid. It is what
// separates a pink carbon copy from brown wood, or a white sheet from a blue
// pad, where gray and saturation cannot: chroma (Lab a/b) is what
// discriminates, and lightness is left almost free, since a sheet shades
// across its own surface. The mask is not a candidate — a sheet split by its
// own print would hand fusion a half-sheet quad — it is read along the grid
// evidence's march lines, one side at a time, like the shadow line is.
const SHEET_COLOUR_SAMPLES_PER_AXIS = 7;
const SHEET_COLOUR_INSET = 0.1;           // of the frame, clear of its rules
const SHEET_COLOUR_PAPER_SHARE = 0.6;     // the brightest share of samples is paper, not ink
const SHEET_CHROMA_TOLERANCE = 12;        // Lab a and b, either side of the paper's
const SHEET_LIGHTNESS_ALLOWANCE = 70;     // Lab L below the paper's that still counts

// Final margin, so hairline errors land on background rather than content.
const SAFETY_MARGIN_FRACTION = 0.004;

// A quad assembled around grid locks must still look like a sheet, or the
// locks are dropped and the pipeline's own answer stands. These notas are
// roughly half-A4 portrait; widen the aspect band only if other templates
// enter the set.
const GRID_GATES = Object.freeze({
  minAngleDeg: 60, maxAngleDeg: 120,
  minAreaFraction: 0.12, maxAreaFraction: 0.98,
  maxOppositeRatio: 2.5,
  minAspect: 1.2, maxAspect: 2.6,
});

// ------------------------------------------------------------------
// OpenCV bootstrap
// ------------------------------------------------------------------

let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    const started = loadOpenCV();
    initPromise = started;
    // Retire THIS attempt only: a later call may already have replaced it, and
    // clearing a newer promise would compile OpenCV twice over.
    started.catch(() => { if (initPromise === started) initPromise = null; });
  }
  return initPromise;
}

async function loadOpenCV() {
  // Deliberately unstamped: opencv.js never changes, and busting it would
  // cost an ~11 MB refetch on every deploy.
  importScripts("../vendor/opencv.js");
  let module = self.cv;
  // Old Emscripten MODULARIZE builds expose a `.then` shim that resolves with
  // the module itself — `await cv` loops forever on that thenable. Resolve our
  // own promise with undefined and stash the module manually.
  if (module && typeof module.then === "function" && !module.Mat) {
    await new Promise((resolve) => {
      module.then((loaded) => {
        if (loaded && loaded.Mat) self.cv = loaded;
        resolve();
      });
    });
    module = self.cv;
  }
  if (module && !module.Mat) {
    await new Promise((resolve) => { module.onRuntimeInitialized = resolve; });
  }
  if (!self.cv || !self.cv.Mat) throw new Error("OpenCV failed to initialize");
}

function toImageData(width, height, buffer) {
  return new ImageData(new Uint8ClampedArray(buffer), width, height);
}

/** Frees every Mat handed to it, skipping the slots never filled. Lets the
 *  allocations sit INSIDE the try that frees them: a throw part way through
 *  would otherwise strand whatever had already been allocated, and at full
 *  resolution that is tens of megabytes of WASM heap. */
function releaseMats(...mats) {
  for (const mat of mats) if (mat) mat.delete();
}

// ------------------------------------------------------------------
// Candidate collection — one pass per mask
// ------------------------------------------------------------------

function cleanMask(pipeline) {
  cv.morphologyEx(pipeline.bin, pipeline.bin, cv.MORPH_OPEN, pipeline.kOpen);
  cv.morphologyEx(pipeline.bin, pipeline.bin, cv.MORPH_CLOSE, pipeline.kClose);
}

function harvestMask(pipeline, maskName) {
  candidatesFromMask(pipeline.bin, {
    width: pipeline.width, height: pipeline.height, out: pipeline.candidates,
    maskName, diag: pipeline.splitDiag, gray: pipeline.gray,
  });
}

function addThresholdCandidates(pipeline, thresholdType, maskName) {
  cv.threshold(pipeline.gray, pipeline.bin, 0, 255, thresholdType);
  cleanMask(pipeline);
  harvestMask(pipeline, maskName);
}

function addAdaptiveCandidates(pipeline) {
  const rawBlock = Math.round(Math.min(pipeline.width, pipeline.height) / ADAPTIVE_BLOCK_DIVISOR) | 1;
  const block = Math.max(3, rawBlock);
  cv.adaptiveThreshold(pipeline.gray, pipeline.bin, 255, cv.ADAPTIVE_THRESH_MEAN_C,
    cv.THRESH_BINARY, block % 2 ? block : block + 1, ADAPTIVE_CONSTANT);
  cleanMask(pipeline);
  harvestMask(pipeline, "adaptive");
}

/** The four corners of the printed frame, so its interior can be sampled. */
function frameCorners(frame) {
  const [top, right, bottom, left] = frame.map((border) => border && lineThrough(border.a, border.b));
  if (!top || !right || !bottom || !left) return null;
  const corners = [lineIntersect(left, top), lineIntersect(top, right),
                   lineIntersect(right, bottom), lineIntersect(bottom, left)];
  return corners.every(Boolean) ? corners : null;
}

/** Bilinear point inside a quad given as [tl, tr, br, bl], at (u, v) in 0..1. */
function pointInsideQuad([tl, tr, br, bl], u, v) {
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

/** The paper's Lab colour inside the grid: the median of the brightest share
 *  of a grid of samples, so ink and rulings do not vote. Null without a
 *  complete frame or enough samples inside the image. */
function paperColourInside(lab, frame) {
  const corners = frameCorners(frame);
  if (!corners) return null;
  const samples = [];
  const n = SHEET_COLOUR_SAMPLES_PER_AXIS;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u = SHEET_COLOUR_INSET + (1 - 2 * SHEET_COLOUR_INSET) * (i + 0.5) / n;
      const v = SHEET_COLOUR_INSET + (1 - 2 * SHEET_COLOUR_INSET) * (j + 0.5) / n;
      const point = pointInsideQuad(corners, u, v);
      const x = Math.round(point.x), y = Math.round(point.y);
      if (x < 0 || y < 0 || x >= lab.cols || y >= lab.rows) continue;
      const pixel = lab.ucharPtr(y, x);
      samples.push({ l: pixel[0], a: pixel[1], b: pixel[2] });
    }
  }
  if (samples.length < n) return null;
  samples.sort((p, q) => q.l - p.l);
  const paper = samples.slice(0, Math.max(1, Math.round(samples.length * SHEET_COLOUR_PAPER_SHARE)));
  const medianOf = (key) => median(paper.map((s) => s[key]).sort(ascending));
  return { l: medianOf("l"), a: medianOf("a"), b: medianOf("b") };
}

/** Everything that shares the sheet's chroma, at any lightness down to deep
 *  shadow: a CV_8UC1 mask the grid evidence reads along its march lines, or
 *  null when the frame is incomplete. Unlike the candidate masks it is not
 *  opened or closed — print inside the sheet is a gap the march steps over,
 *  and a morphology that bridged it would also bridge the sheet to a
 *  neighbour of the same colour. */
function sheetColourMask(pipeline, grid) {
  let rgb = null, lab = null, low = null, high = null;
  try {
    rgb = new cv.Mat();
    lab = new cv.Mat();
    cv.cvtColor(pipeline.img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const paper = paperColourInside(lab, grid.frame);
    if (!paper) return null;
    low = new cv.Mat(lab.rows, lab.cols, lab.type(), new cv.Scalar(
      Math.max(0, paper.l - SHEET_LIGHTNESS_ALLOWANCE), paper.a - SHEET_CHROMA_TOLERANCE, paper.b - SHEET_CHROMA_TOLERANCE));
    high = new cv.Mat(lab.rows, lab.cols, lab.type(), new cv.Scalar(
      255, paper.a + SHEET_CHROMA_TOLERANCE, paper.b + SHEET_CHROMA_TOLERANCE));
    const mask = new cv.Mat();
    cv.inRange(lab, low, high, mask);
    pipeline.sheetColour = paper; // for the trace
    return mask;
  } finally {
    releaseMats(rgb, lab, low, high);
  }
}

/** Paper is colorless even in shadow while wood and desks are saturated, so
 *  this mask survives brightness gradients that break gray thresholds. */
function addSaturationCandidates(pipeline) {
  let rgb = null, hsv = null, channels = null, saturation = null;
  try {
    rgb = new cv.Mat();
    hsv = new cv.Mat();
    channels = new cv.MatVector();
    cv.cvtColor(pipeline.img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    // A MatVector element is its own Mat wrapper and has to be freed
    // separately from the vector.
    saturation = channels.get(1);
    cv.GaussianBlur(saturation, saturation, new cv.Size(BLUR_KERNEL_SIZE, BLUR_KERNEL_SIZE), 0);
    cv.threshold(saturation, pipeline.bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cleanMask(pipeline);
    harvestMask(pipeline, "saturation");
  } finally {
    releaseMats(saturation, rgb, hsv);
    if (channels) channels.delete();
  }
}

/** Straight segments from the Canny mask BEFORE dilation — partial document
 *  edges (behind occluders, soft seams) become usable side candidates even
 *  when no mask isolates a full quad from them.
 *
 *  HoughLinesP is ~20% of a detection but only three sides in the whole test
 *  set actually use its output, so this runs lazily: `edges` is kept aside and
 *  the transform happens only if edge fusion asks for segments. */
function harvestHoughSegments(pipeline, edges) {
  const segments = [];
  const linesMat = new cv.Mat();
  try {
    cv.HoughLinesP(edges, linesMat, 1, Math.PI / 180, HOUGH_THRESHOLD,
      HOUGH_MIN_LENGTH_FRACTION * Math.min(pipeline.width, pipeline.height), HOUGH_MAX_GAP);
    for (let i = 0; i < Math.min(linesMat.rows, MAX_HOUGH_SEGMENTS); i++) {
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

/** Edge-based candidates: a contrast-independent paper outline. The soft pass
 *  catches low-contrast paper edges in shadow. */
function addCannyCandidates(pipeline) {
  cv.Canny(pipeline.gray, pipeline.bin, CANNY_LOW, CANNY_HIGH);
  // Keep the undilated edges so the Hough transform can run later, if at all.
  pipeline.cannyEdges = new cv.Mat();
  pipeline.bin.copyTo(pipeline.cannyEdges);
  cv.dilate(pipeline.bin, pipeline.bin, pipeline.kDilate);
  harvestMask(pipeline, "canny");

  cv.Canny(pipeline.gray, pipeline.bin, CANNY_SOFT_LOW, CANNY_SOFT_HIGH);
  cv.dilate(pipeline.bin, pipeline.bin, pipeline.kDilate);
  harvestMask(pipeline, "canny-soft");
}

/** Memoized: the transform runs at most once per detection, and only if asked. */
function createSegmentSource(pipeline) {
  let segments = null;
  return () => {
    if (!segments) segments = harvestHoughSegments(pipeline, pipeline.cannyEdges);
    return segments;
  };
}

/** The blurred grayscale every mask and every probe reads from. */
function prepareGray(pipeline) {
  cv.cvtColor(pipeline.img, pipeline.gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(pipeline.gray, pipeline.gray,
    new cv.Size(BLUR_KERNEL_SIZE, BLUR_KERNEL_SIZE), 0);
}

function collectCandidates(pipeline) {
  prepareGray(pipeline);
  addThresholdCandidates(pipeline, cv.THRESH_BINARY + cv.THRESH_OTSU, "otsu");
  addThresholdCandidates(pipeline, cv.THRESH_BINARY_INV + cv.THRESH_OTSU, "otsu-inv");
  addAdaptiveCandidates(pipeline);
  addSaturationCandidates(pipeline);
  addCannyCandidates(pipeline);
}

function selectBestCandidate(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate.rejected) continue;
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

// ------------------------------------------------------------------
// Best-candidate corrections
// ------------------------------------------------------------------

/** Which sides `fuller` extends beyond `body` by more than the margin. */
function extendedSides(fuller, body, margin) {
  const extended = new Set();
  for (let type = 0; type < SIDE_COUNT; type++) {
    if (quadSideOutwardness(fuller, type) > quadSideOutwardness(body, type) + margin) {
      extended.add(type);
    }
  }
  return extended;
}

function isWellFormedQuad(quad, bounds) {
  return quadPoints(quad).every((point) =>
    point.x >= -REUNITE_MAX_OUT_OF_FRAME * bounds.width &&
    point.x <= (1 + REUNITE_MAX_OUT_OF_FRAME) * bounds.width &&
    point.y >= -REUNITE_MAX_OUT_OF_FRAME * bounds.height &&
    point.y <= (1 + REUNITE_MAX_OUT_OF_FRAME) * bounds.height);
}

function fullerCandidateContaining(best, candidates) {
  let fuller = null;
  for (const candidate of candidates) {
    if (candidate === best || candidate.rejected || candidate.split || !candidate.corners) continue;
    if (candidate.quadArea < best.quadArea * REUNITE_MIN_AREA_RATIO) continue;
    if (candidate.score < REUNITE_MIN_SCORE) continue;
    if (fracOutsideQuad(best.hullPts, candidate.corners) > REUNITE_MAX_OUTSIDE) continue;
    if (!fuller || candidate.score > fuller.score) fuller = candidate;
  }
  return fuller;
}

/**
 * Reunites a severed document section. A dark internal band (a coloured
 * receipt header, a fold shadow) can sever the document TOP into its own blob
 * under the morphology, so the cleaner BODY sub-rectangle outscores the whole
 * document. If best sits almost entirely inside a substantially larger, still
 * plausible candidate, prefer that fuller one — cropping to the body would cut
 * the severed section's content.
 *
 * The severing band is a strong interior edge that fusion, the snap and the
 * net would re-select as the boundary, undoing the reunion, so the extended
 * sides are locked.
 *
 * @returns {best, lock} — unchanged with lock null when no reunion applies
 */
function reuniteSeveredSection(best, pipeline, trace) {
  const { candidates, width, height } = pipeline;
  // Split winners are exempt: their tightness is intentional (the stack fixes).
  if (!best || best.split || !best.hullPts) return { best, lock: null };
  const fuller = fullerCandidateContaining(best, candidates);
  if (!fuller) return { best, lock: null };

  const margin = REUNITE_LOCK_MARGIN_FRACTION * Math.min(width, height);
  const lock = extendedSides(fuller.corners, best.corners, margin);

  // A genuine severed section is a single edge or one adjacent corner.
  // Extending an OPPOSITE pair (top+bottom / left+right) is a general
  // enlargement by a looser mask, not a reunion — reject it.
  const opposite = (lock.has(SIDE_TOP) && lock.has(SIDE_BOTTOM)) ||
                   (lock.has(SIDE_RIGHT) && lock.has(SIDE_LEFT));
  // A corner far off-image means a distorted blob (a paper fold), not the
  // true document.
  if (!lock.size || opposite || !isWellFormedQuad(fuller.corners, pipeline)) {
    return { best, lock: null };
  }
  if (trace) trace.push({ reunite: true, from: best.mask, to: fuller.mask, lock: [...lock] });
  return { best: fuller, lock };
}

/**
 * Safe-split override: when the merged best is essentially the union a safe
 * split decomposed (the parent blob's bbox ≈ best's bbox), prefer the best
 * safe part — its lobe protrudes outside the kept quad, so cropping to it cuts
 * nothing. Unsafe splits never reach here.
 */
function applySafeSplitOverride(best, candidates, trace) {
  if (!best || best.split) return best;
  const bestBox = bboxOf(best.corners);
  const linked = candidates.filter((candidate) => candidate.safe && !candidate.rejected &&
    bboxIoU(candidate.parentBBox, bestBox) >= SAFE_OVERRIDE_MIN_BBOX_IOU);
  if (!linked.length) return best;

  const strongest = linked.reduce((a, b) => (b.score > a.score ? b : a));
  if (strongest.score < SAFE_OVERRIDE_MIN_SCORE_RATIO * best.score) return best;
  if (trace) {
    trace.push({ safeOverride: true, mask: strongest.mask,
      fromScore: +best.score.toFixed(4), toScore: +strongest.score.toFixed(4) });
  }
  return strongest;
}

/**
 * The cut chord of a winning safe split is the doc/occluder seam, and a
 * reunion's extended sides are the severing band: both are locked against
 * outward fusion walks and snap marches.
 *
 * @returns Map<sideType, side|null> — a locked side with `null` keeps best's
 *          own side (these two sources); a side value locks to that line
 *          (grid evidence). Null when nothing is locked.
 */
function lockedSidesFor(best, reuniteLock) {
  const splitLock = best.split && best.safe && best.cutSides ? best.cutSides : [];
  if (!splitLock.length && !reuniteLock) return null;
  const locks = new Map();
  for (const type of [...splitLock, ...(reuniteLock || [])]) locks.set(type, null);
  return locks;
}

/**
 * Hull-cut safety net: a final side slicing deep into the best blob's hull is
 * cutting probable content, so push it back out.
 *
 * The net triggers on a cut of best's HULL but recovers only to the CONSENSUS
 * region — the document part, when another mask isolates it from a merged
 * neighbour. That tightens the loose-merge case while still covering true
 * content cuts, and is the identity when no evidence isolates the document.
 */
function applyHullCutNet(corners, options) {
  const { best, candidates, contributors, locked, width, height, trace, rules } = options;
  const info = trace ? {} : null;
  const protectedRegion = consensusHull(corners,
    { best, candidates, contributors, width, height, info });
  if (trace) {
    trace.push({ consensus: true, keptFrac: info && info.keptFrac,
      clippers: info && info.clippers });
  }

  let result = corners;
  for (let type = 0; type < SIDE_COUNT; type++) {
    if (locked && locked.has(type)) continue;
    const hullCut = fracCutBySide(best.hullPts, result, type);
    if (trace) {
      trace.push({ hullCut: type, frac: +hullCut.toFixed(3),
        fracCons: +fracCutBySide(protectedRegion, result, type).toFixed(3),
        rule: rules ? rules[type] : undefined,
        covered: hullCut > HULL_CUT_THRESHOLD });
    }
    if (hullCut > HULL_CUT_THRESHOLD) {
      result = coverSide(result, type, { points: protectedRegion, bounds: { width, height } });
    }
  }
  return result;
}

// ------------------------------------------------------------------
// detect
// ------------------------------------------------------------------

/**
 * Sides the printed grid can vouch for, added to the locks already in force.
 * Nothing changes for a photo with no grid, and a side another lock already
 * owns is left to it — a split's cut chord outranks a margin estimate.
 * @returns the widened lock map, or null when the grid added nothing
 */
function gridLocksFor(pipeline, baseLocks, trace) {
  const grid = pipeline.grid;
  if (trace) {
    trace.push({ grid: grid
      ? { inliers: grid.inliers, borders: grid.frame.map(Boolean), foreign: grid.foreign.length,
          foreignSegments: grid.foreign } // for the overlay page
      : null });
  }
  if (!grid) return null;

  const locks = new Map(baseLocks || []);
  let added = 0;
  if (trace && pipeline.sheetColour) trace.push({ sheetColour: pipeline.sheetColour });
  for (const { type, side, confidence, evidence, source, other } of gridSideEvidence(pipeline, grid, pipeline.sheetMask)) {
    const locked = confidence >= GRID.lockConfidence && !locks.has(type);
    if (trace) {
      trace.push({ gridSide: type, locked, side, ...sideEvidenceTrace(source, confidence, evidence),
                   other: other && sideEvidenceTrace(other.source, other.confidence, other.evidence) });
    }
    if (locked) { locks.set(type, side); added++; }
  }
  return added ? locks : null;
}

/** One kind of side evidence, rounded for the trace, with what the overlay
 *  page draws: where the search ran and what it read. */
function sideEvidenceTrace(source, confidence, evidence) {
  const rounded = (value, digits) => (value === null ? null : +value.toFixed(digits));
  return { source, confidence: rounded(confidence, 2),
    coverage: rounded(evidence.coverage, 2), stops: evidence.stops.length,
    shadow: rounded(evidence.signals.shadow, 2), prior: rounded(evidence.signals.prior, 2),
    residual: rounded(evidence.residual, 4), curled: evidence.curled,
    reference: evidence.reference, excluded: evidence.excluded, exclusions: evidence.exclusions,
    agreement: rounded(evidence.agreement, 2), uniformity: rounded(evidence.uniformity, 2),
    distance: rounded(evidence.distance, 3),
    border: evidence.border, normal: evidence.normal, profiles: evidence.profiles,
    stopPoints: evidence.stops.map((stop) => ({ x: stop.x, y: stop.y })) };
}

/** Why a grid-locked quad is not a sheet, or null when it passes. */
function gridGateFailure(corners, bounds) {
  const { minAngleDeg, maxAngleDeg, minAreaFraction, maxAreaFraction,
          maxOppositeRatio, minAspect, maxAspect } = GRID_GATES;
  if (internalAngles(corners).some((angle) => angle < minAngleDeg || angle > maxAngleDeg)) return "angle";
  const areaFraction = shoelaceArea(corners) / (bounds.width * bounds.height);
  if (areaFraction < minAreaFraction || areaFraction > maxAreaFraction) return "area";
  const length = (type) => segmentLength(sideOf(corners, type));
  const ratio = (first, second) => Math.max(first, second) / Math.min(first, second);
  const top = length(SIDE_TOP), bottom = length(SIDE_BOTTOM);
  const left = length(SIDE_LEFT), right = length(SIDE_RIGHT);
  if (ratio(top, bottom) > maxOppositeRatio || ratio(left, right) > maxOppositeRatio) return "opposite";
  const aspect = ratio((top + bottom) / 2, (left + right) / 2);
  if (aspect < minAspect || aspect > maxAspect) return "aspect";
  return null;
}

/** Fusion, refinement, snap and the anti-cut net, in that order, all
 *  honouring `locks`. */
function assembleCorners(best, pipeline, locks, trace) {
  const { gray, width, height, candidates, getSegments } = pipeline;
  const fuseMeta = {};
  const fused = fuseQuad(candidates, best,
    { gray, width, height, getSegments, trace, locks, meta: fuseMeta });

  // refineQuadEdges returns its input unchanged without hull evidence, so this
  // needs no guard of its own — the same condition the net applies below.
  let corners = fused || refineQuadEdges(best.corners, best.hullPts, pipeline);
  corners = snapSidesOutward(pipeline, corners, locks);

  if (fused && best.hullPts && best.hullPts.length >= 3) {
    corners = applyHullCutNet(corners, {
      best, candidates, contributors: fuseMeta.contributors, locked: locks,
      width, height, trace, rules: fuseMeta.rules,
    });
  }
  const margin = SAFETY_MARGIN_FRACTION * Math.min(width, height);
  return { corners: expandQuad(corners, margin, pipeline), fusedOk: !!fused };
}

/**
 * The corners: assembled around the grid's locks when the grid can vouch for
 * any side and the result still looks like a sheet; otherwise assembled the
 * way the pipeline always has. The second path is the fallback, not a retry —
 * it is the detector that works on everything without a printed grid.
 *
 * The gates exist so the locks cannot make the quad less like a sheet. When
 * the fallback fails a gate too, they have nothing to protect, and the sides
 * with evidence behind them stand.
 */
function buildCorners(best, pipeline, trace) {
  const baseLocks = lockedSidesFor(best, pipeline.reuniteLock);
  const gridLocks = gridLocksFor(pipeline, baseLocks, trace);
  if (!gridLocks) return assembleCorners(best, pipeline, baseLocks, trace);
  const built = assembleCorners(best, pipeline, gridLocks, trace);
  const failure = gridGateFailure(built.corners, pipeline);
  if (!failure) {
    if (trace) trace.push({ gridGate: "passed" });
    return built;
  }
  const fallback = assembleCorners(best, pipeline, baseLocks, trace);
  const fallbackFailure = gridGateFailure(fallback.corners, pipeline);
  if (trace) trace.push({ gridGate: failure, fallbackGate: fallbackFailure || "passed" });
  return fallbackFailure ? built : fallback;
}

function debugPayload(candidates) {
  return candidates.map((candidate) => ({
    mask: candidate.mask, score: +candidate.score.toFixed(4),
    rejected: !!candidate.rejected, noQuad: !!candidate.noQuad,
    areaFrac: candidate.areaFrac, split: !!candidate.split, safe: !!candidate.safe,
    protrusionOut: candidate.protrusionOut !== undefined ? +candidate.protrusionOut.toFixed(3) : undefined,
    protrusionIn: candidate.protrusionIn !== undefined ? +candidate.protrusionIn.toFixed(3) : undefined,
    selfOut: candidate.selfOut !== undefined ? +candidate.selfOut.toFixed(3) : undefined,
    cutSides: candidate.cutSides,
    corners: candidate.corners && {
      tl: candidate.corners.tl, tr: candidate.corners.tr,
      br: candidate.corners.br, bl: candidate.corners.bl,
    },
  }));
}

/**
 * Finds the document outline. Candidate masks (OTSU both polarities, local
 * adaptive threshold, saturation, dilated Canny at two sensitivities) each
 * yield scored quads from their outer contours; edge fusion assembles the best
 * four sides, an outward snap recovers any clipped strips, and a small margin
 * guarantees hairline errors never cut content.
 */
/** The pipeline's Mat slots start empty so a throw mid-allocation still leaves
 *  something releasePipeline can clean up. */
function createPipeline(width, height, debug) {
  return {
    width, height,
    img: null, gray: null, bin: null,
    kOpen: null, kClose: null, kDilate: null,
    candidates: [],
    splitDiag: debug ? [] : null,
    reuniteLock: null,
    cannyEdges: null,
    getSegments: null,
    grid: null,
    sheetMask: null,
    sheetColour: null,
  };
}

function squareKernel(size) {
  return cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size));
}

/** @param kernels { open, close, dilate } — DETECT_KERNELS or PREVIEW_KERNELS */
function allocatePipelineMats(pipeline, buffer, kernels) {
  pipeline.img = cv.matFromImageData(toImageData(pipeline.width, pipeline.height, buffer));
  pipeline.gray = new cv.Mat();
  pipeline.bin = new cv.Mat();
  pipeline.kOpen = squareKernel(kernels.open);
  pipeline.kClose = squareKernel(kernels.close);
  pipeline.kDilate = squareKernel(kernels.dilate);
}

function releasePipeline(pipeline) {
  releaseMats(pipeline.img, pipeline.gray, pipeline.bin,
    pipeline.kOpen, pipeline.kClose, pipeline.kDilate, pipeline.cannyEdges, pipeline.sheetMask);
}

function detect({ width, height, buffer, debug, withoutGrid }) {
  const pipeline = createPipeline(width, height, debug);
  pipeline.withoutGrid = !!withoutGrid;
  try {
    allocatePipelineMats(pipeline, buffer, DETECT_KERNELS);
    collectCandidates(pipeline);
    pipeline.getSegments = createSegmentSource(pipeline);
    // The printed grid, found once: it vouches for sides in buildCorners, and
    // its interior tells the sheet-colour mask what colour to look for.
    // `withoutGrid` is the overlay page's before/after switch, nothing more.
    pipeline.grid = pipeline.withoutGrid ? null : findPrintedGrid(pipeline, pipeline.getSegments(), pipeline);
    pipeline.sheetMask = pipeline.grid ? sheetColourMask(pipeline, pipeline.grid) : null;
    const candidates = pipeline.candidates;
    const trace = debug ? [] : null;

    let best = selectBestCandidate(candidates);
    const reunion = reuniteSeveredSection(best, pipeline, trace);
    best = reunion.best;
    pipeline.reuniteLock = reunion.lock;
    best = applySafeSplitOverride(best, candidates, trace);

    let corners = null;
    let fusedOk = false;
    if (best) {
      const built = buildCorners(best, pipeline, trace);
      corners = built.corners;
      fusedOk = built.fusedOk;
    }

    if (!debug) return { corners };
    // Debug callers expect the segment list regardless of whether fusion
    // needed it, so force it here rather than reporting a lazy null.
    return {
      corners, fusedOk, trace, segments: pipeline.getSegments(),
      splitDiag: pipeline.splitDiag,
      debug: debugPayload(candidates),
    };
  } finally {
    releasePipeline(pipeline);
  }
}

// ------------------------------------------------------------------
// previewQuad
// ------------------------------------------------------------------

/**
 * Where the document appears to be, for the live viewfinder outline. The
 * first third of `detect` — gray, blur, the Otsu mask and its inverse as a
 * fallback — through the same contour, hull and scoring code, with no fusion,
 * refinement, snap or net. Runs at a quarter of detection's pixels and one or
 * two masks instead of five, so it can keep up with a camera feed; the price
 * is that it misses scenes the full detector catches. It only ever draws an
 * outline. The crop still comes from `detect` on the captured photo.
 */
function previewQuad({ width, height, buffer }) {
  const pipeline = createPipeline(width, height, false);
  try {
    allocatePipelineMats(pipeline, buffer, PREVIEW_KERNELS);
    prepareGray(pipeline);
    addThresholdCandidates(pipeline, cv.THRESH_BINARY + cv.THRESH_OTSU, "otsu");
    // The inverted mask is the fallback, not a second opinion: on every scene
    // in the set where the bright mask finds a quad, that quad is the one
    // that wins, and the second mask costs as much again as the first.
    if (!selectBestCandidate(pipeline.candidates)) {
      addThresholdCandidates(pipeline, cv.THRESH_BINARY_INV + cv.THRESH_OTSU, "otsu-inv");
    }
    const best = selectBestCandidate(pipeline.candidates);
    return { corners: best ? best.corners : null };
  } finally {
    releasePipeline(pipeline);
  }
}

// ------------------------------------------------------------------
// warp
// ------------------------------------------------------------------

function warp({ width, height, buffer, corners, dstW, dstH, enhance }) {
  const { tl, tr, br, bl } = corners;
  let src = null, srcTri = null, dstTri = null, transform = null, dst = null;
  try {
    src = cv.matFromImageData(toImageData(width, height, buffer));
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [0, 0, dstW, 0, dstW, dstH, 0, dstH]);
    transform = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    // Bilinear resampling only — the geometry never filters pixel values.
    cv.warpPerspective(src, dst, transform, new cv.Size(dstW, dstH),
      cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    // The optional natural-flash lift runs here, on the cropped scan, so its
    // tiles only ever contain document rather than desk.
    if (!enhance) return new Uint8ClampedArray(dst.data).buffer;
    const enhanced = enhanceScan(dst);
    try {
      return new Uint8ClampedArray(enhanced.data).buffer;
    } finally {
      enhanced.delete();
    }
  } finally {
    releaseMats(src, srcTri, dstTri, transform, dst);
  }
}

// ------------------------------------------------------------------
// denoise
// ------------------------------------------------------------------

// A 3x3 median is the only filter in this build that actually removes sensor
// grain: bilateralFilter's range kernel preserves the very speckle it is aimed
// at (+1.0 dB against this filter's +5.0 dB, measured at every sigma), and a
// 5x5 median removes less noise than it does detail.
const DENOISE_KERNEL_SIZE = 3;

/**
 * Removes sensor grain from a full-resolution camera frame.
 *
 * Only worth doing BEFORE the capture downscale. Measured on a noisy frame
 * against its clean original: filtering the full frame gains 2.7 dB, while
 * filtering after the downscale gains 1.2 dB at best and loses 1.5 dB at the
 * ratios high detail used to use — past that point the downscale has already
 * averaged the grain away, so the median only eats real pixels.
 *
 * @returns the filtered pixels as a transferable buffer
 */
function denoise({ width, height, buffer }) {
  let src = null, rgb = null, out = null;
  try {
    src = cv.matFromImageData(toImageData(width, height, buffer));
    rgb = new cv.Mat();
    out = new cv.Mat();
    // Canvas alpha is uniformly opaque, so dropping it around the filter loses
    // nothing and costs nothing: sorting three channels instead of four
    // measures 122ms against 159ms at 2560x1440.
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.medianBlur(rgb, rgb, DENOISE_KERNEL_SIZE);
    cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
    return new Uint8ClampedArray(out.data).buffer;
  } finally {
    releaseMats(src, rgb, out);
  }
}

// ------------------------------------------------------------------
// Message dispatch
// ------------------------------------------------------------------

/** One entry per message type, each returning the fields to merge into the
 *  reply plus any buffers to hand over rather than copy. A Map rather than an
 *  object literal so an unknown type can never resolve to Object.prototype. */
const HANDLERS = new Map([
  ["init", () => ({ result: {} })],
  ["detect", (payload) => ({ result: detect(payload) })],
  ["previewQuad", (payload) => ({ result: previewQuad(payload) })],
  ["warp", (payload) => {
    const buffer = warp(payload);
    return { result: { buffer }, transferables: [buffer] };
  }],
  ["denoise", (payload) => {
    const buffer = denoise(payload);
    return { result: { buffer }, transferables: [buffer] };
  }],
]);

async function handleMessage({ id, type, ...payload }) {
  const handler = HANDLERS.get(type);
  if (!handler) {
    self.postMessage({ id, ok: false, error: "Unknown message type: " + type });
    return;
  }
  await ensureInit();
  const { result, transferables } = handler(payload);
  self.postMessage({ id, ok: true, ...result }, transferables || []);
}

self.onmessage = (event) => {
  handleMessage(event.data).catch((error) => {
    self.postMessage({ id: event.data.id, ok: false,
      error: error && error.message ? error.message : String(error) });
  });
};
