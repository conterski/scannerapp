/* scan-worker.js — runs OpenCV.js off the main thread: document detection and
 * its perspective warp, and the quick look the live viewfinder outline is
 * drawn from.
 *
 * Protocol: postMessage({id, type, ...}) → postMessage({id, ok, ...})
 *   init        → loads OpenCV
 *   detect      {width, height, buffer, engine?, debug?, prior?, skip?} → {corners|null, confidence, refinement?}
 *   previewQuad {width, height, buffer}                          → {corners|null}
 *   verify      {strips, corners, width, height}                 → {corners, sides}  (side-verify.js)
 *   scoreQuad   {width, height, buffer, corners}                 → {score, frame}   (overlay page only)
 *   warp        {width, height, buffer, corners, dstW, dstH}     → {buffer}
 *
 * The detector lives in worker/, one shared global scope: geometry (pure
 * math), pixel-probes (what the pixels say), candidates (mask → scored
 * quads), edge-fusion (assembling the best four sides), quad-refine (the
 * anti-cut passes), grid-evidence (the printed grid as proof of where a
 * sheet on a pad ends) — the legacy pipeline — then frame, quad-score,
 * line-candidates, side-refit and quad-search, which tighten its crop by a
 * score (engine "refined", the default). This file owns the pipeline that
 * runs them in order.
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
  "worker/frame.js",
  "worker/quad-score.js",
  "worker/line-candidates.js",
  "worker/side-refit.js",
  "worker/side-verify.js",
  "worker/quad-search.js",
].map((path) => path + ASSET_VERSION));

// Morphology: an aggressive OPEN severs thin bright bridges between the paper
// and adjacent objects (other papers, glare) so blobs don't merge. Sized for
// the ~800px frame detection runs at.
const DETECT_KERNELS = { open: 13, close: 7, dilate: 7 };

// The live viewfinder outline runs the same masks at ~400px, so its kernels
// are scaled to match — the detection sizes would swallow a page at that
// scale. This is a quick look for framing, not the crop.
const PREVIEW_KERNELS = { open: 7, close: 3, dilate: 3 };

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

// Preferring a safe split part over the merged blob it came from.
const SAFE_OVERRIDE_MIN_BBOX_IOU = 0.6;
const SAFE_OVERRIDE_MIN_SCORE_RATIO = 0.5;

// Hull-cut safety net. Calibrated on the full test set: legitimate fusion
// pull-ins (trimming blob overshoot) measure <= 0.072 of hull area, while
// content cuts (an interior table line winning a side) measure >= 0.104. A
// false positive only loosens the crop, which is the accepted bias.
const HULL_CUT_THRESHOLD = 0.09;

// The sheet's own colour (SHEET_COLOUR, pixel-probes.js), sampled inside
// its printed grid, is what separates a pink carbon copy from brown wood, or
// a white sheet from a blue pad, where gray and saturation cannot: chroma
// (Lab a/b) discriminates, and lightness is left almost free, since a sheet
// shades across its own surface. The mask is not a candidate — a sheet
// split by its own print would hand fusion a half-sheet quad — it is read
// along the grid evidence's march lines, one side at a time, like the
// shadow line is.

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
    maskName, gray: pipeline.gray,
  });
}

function addThresholdCandidates(pipeline, thresholdType, maskName) {
  cv.threshold(pipeline.gray, pipeline.bin, 0, 255, thresholdType);
  cleanMask(pipeline);
  harvestMask(pipeline, maskName);
}

function addAdaptiveCandidates(pipeline) {
  const block = Math.max(3, Math.round(shortSideOf(pipeline) / ADAPTIVE_BLOCK_DIVISOR) | 1); // odd, as the API wants
  cv.adaptiveThreshold(pipeline.gray, pipeline.bin, 255, cv.ADAPTIVE_THRESH_MEAN_C,
    cv.THRESH_BINARY, block, ADAPTIVE_CONSTANT);
  cleanMask(pipeline);
  harvestMask(pipeline, "adaptive");
}

/** The printed frame as a quad, so its interior can be sampled; null
 *  without all four borders. */
function frameQuad(frame) {
  if (!frame.every(Boolean)) return null;
  const [tl, tr, br, bl] = cornersOfSideLines(frame.map((border) => lineThrough(border.a, border.b)));
  return tl && tr && br && bl ? { tl, tr, br, bl } : null;
}

/** Everything that shares the sheet's chroma, at any lightness down to deep
 *  shadow: a CV_8UC1 mask the grid evidence reads along its march lines, or
 *  null when the frame is incomplete. Unlike the candidate masks it is not
 *  opened or closed — print inside the sheet is a gap the march steps over,
 *  and a morphology that bridged it would also bridge the sheet to a
 *  neighbour of the same colour. */
function sheetColourMask(pipeline, grid) {
  let rgb = null, lab = null, low = null, high = null, mask = null;
  try {
    rgb = new cv.Mat();
    lab = new cv.Mat();
    cv.cvtColor(pipeline.img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const quad = frameQuad(grid.frame);
    const labAt = (x, y) => { const pixel = lab.ucharPtr(y, x); return { l: pixel[0], a: pixel[1], b: pixel[2] }; };
    const paper = quad && paperColourInside(quad, pipeline, labAt);
    if (!paper) return null;
    const { chromaTolerance, lightnessAllowance } = SHEET_COLOUR;
    low = new cv.Mat(lab.rows, lab.cols, lab.type(), new cv.Scalar(
      Math.max(0, paper.l - lightnessAllowance), paper.a - chromaTolerance, paper.b - chromaTolerance));
    high = new cv.Mat(lab.rows, lab.cols, lab.type(), new cv.Scalar(
      255, paper.a + chromaTolerance, paper.b + chromaTolerance));
    mask = new cv.Mat();
    cv.inRange(lab, low, high, mask);
    const done = mask;
    mask = null; // the caller's now
    return done;
  } finally {
    releaseMats(rgb, lab, low, high, mask);
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
      HOUGH_MIN_LENGTH_FRACTION * shortSideOf(pipeline), HOUGH_MAX_GAP);
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
function reuniteSeveredSection(best, pipeline) {
  const { candidates } = pipeline;
  // Split winners are exempt: their tightness is intentional (the stack fixes).
  if (!best || best.split || !best.hullPts) return { best, lock: null };
  const fuller = fullerCandidateContaining(best, candidates);
  if (!fuller) return { best, lock: null };

  const margin = REUNITE_LOCK_MARGIN_FRACTION * shortSideOf(pipeline);
  const lock = extendedSides(fuller.corners, best.corners, margin);

  // A genuine severed section is a single edge or one adjacent corner.
  // Extending an OPPOSITE pair (top+bottom / left+right) is a general
  // enlargement by a looser mask, not a reunion — reject it.
  const opposite = (lock.has(SIDE_TOP) && lock.has(SIDE_BOTTOM)) ||
                   (lock.has(SIDE_RIGHT) && lock.has(SIDE_LEFT));
  // A corner far off-image means a distorted blob (a paper fold), not the
  // true document.
  if (!lock.size || opposite || outOfBounds(quadPoints(fuller.corners), pipeline, OUT_OF_FRAME_TOLERANCE)) {
    return { best, lock: null };
  }
  return { best: fuller, lock };
}

/**
 * Safe-split override: when the merged best is essentially the union a safe
 * split decomposed (the parent blob's bbox ≈ best's bbox), prefer the best
 * safe part — its lobe protrudes outside the kept quad, so cropping to it cuts
 * nothing. Unsafe splits never reach here.
 */
function applySafeSplitOverride(best, candidates) {
  if (!best || best.split) return best;
  const bestBox = bboxOf(best.corners);
  const linked = candidates.filter((candidate) => candidate.safe && !candidate.rejected &&
    bboxIoU(candidate.parentBBox, bestBox) >= SAFE_OVERRIDE_MIN_BBOX_IOU);
  if (!linked.length) return best;

  const strongest = linked.reduce((a, b) => (b.score > a.score ? b : a));
  if (strongest.score < SAFE_OVERRIDE_MIN_SCORE_RATIO * best.score) return best;
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
  const { best, candidates, contributors, locked, width, height } = options;
  const protectedRegion = consensusHull(corners, { best, candidates, contributors, width, height });

  let result = corners;
  for (let type = 0; type < SIDE_COUNT; type++) {
    if (locked && locked.has(type)) continue;
    if (fracCutBySide(best.hullPts, result, type) > HULL_CUT_THRESHOLD) {
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
function gridLocksFor(pipeline, baseLocks) {
  const grid = pipeline.grid;
  if (!grid) return null;
  const locks = new Map(baseLocks || []);
  let added = 0;
  for (const { type, side, confidence } of gridSideEvidence(pipeline, grid, pipeline.sheetMask)) {
    if (confidence >= GRID.lockConfidence && !locks.has(type)) { locks.set(type, side); added++; }
  }
  return added ? locks : null;
}

/** Why a grid-locked quad is not a sheet, or null when it passes. */
function gridGateFailure(corners, bounds) {
  const { minAngleDeg, maxAngleDeg, minAreaFraction, maxAreaFraction,
          maxOppositeRatio, minAspect, maxAspect } = GRID_GATES;
  if (internalAngles(corners).some((angle) => angle < minAngleDeg || angle > maxAngleDeg)) return "angle";
  const areaFraction = shoelaceArea(corners) / (bounds.width * bounds.height);
  if (areaFraction < minAreaFraction || areaFraction > maxAreaFraction) return "area";
  const { opposite, aspect } = sideRatios(corners);
  if (opposite > maxOppositeRatio) return "opposite";
  if (aspect < minAspect || aspect > maxAspect) return "aspect";
  return null;
}

/** Fusion, refinement, snap and the anti-cut net, in that order, all
 *  honouring `locks`. */
function assembleCorners(best, pipeline, locks) {
  const { gray, width, height, candidates, getSegments } = pipeline;
  const fuseMeta = {};
  const fused = pipeline.skip.has("fusion") ? null : fuseQuad(candidates, best, { gray, width, height, getSegments, locks, meta: fuseMeta });

  // refineQuadEdges returns its input unchanged without hull evidence, so this
  // needs no guard of its own — the same condition the net applies below.
  let corners = fused || refineQuadEdges(best.corners, best.hullPts, pipeline);
  if (!pipeline.skip.has("snap")) corners = snapSidesOutward(pipeline, corners, locks);

  if (!pipeline.skip.has("net") && fused && best.hullPts && best.hullPts.length >= 3) {
    corners = applyHullCutNet(corners, {
      best, candidates, contributors: fuseMeta.contributors, locked: locks, width, height,
    });
  }
  return expandQuad(corners, SAFETY_MARGIN_FRACTION * shortSideOf(pipeline), pipeline);
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
function buildCorners(best, pipeline) {
  const baseLocks = lockedSidesFor(best, pipeline.reuniteLock);
  const gridLocks = pipeline.skip.has("grid") ? null : gridLocksFor(pipeline, baseLocks);
  if (!gridLocks) return assembleCorners(best, pipeline, baseLocks);
  const built = assembleCorners(best, pipeline, gridLocks);
  if (!gridGateFailure(built, pipeline)) return built;
  const fallback = assembleCorners(best, pipeline, baseLocks);
  return gridGateFailure(fallback, pipeline) ? built : fallback;
}

/** The pipeline's Mat slots start empty so a throw mid-allocation still leaves
 *  something releasePipeline can clean up. */
function createPipeline(width, height) {
  return {
    width, height,
    img: null, gray: null, bin: null,
    kOpen: null, kClose: null, kDilate: null,
    candidates: [],
    reuniteLock: null,
    cannyEdges: null,
    getSegments: null,
    grid: null,
    sheetMask: null,
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

/**
 * The legacy crop, refined by the score within a bounded drift: the score
 * judges small side moves well — inward too, which the legacy passes never
 * could — and whole relocations badly, so it is asked only the first. The
 * legacy pipeline's Hough segments feed the line pools and the print extent.
 * The re-rank of the legacy's candidates runs before the print extent is
 * known — the extent needs the winner's segments — so it reads seams as
 * rules where the refinement, later, reads them as seams.
 *
 * A camera shot brings the outline the user shot against as `prior`
 * { corners, stability }: it draws the re-rank towards it, and it stands as
 * the crop where the detector finds nothing, or where it holds the
 * detector's crop and the detector's does not beat its score clearly — more
 * clearly the steadier it held. Never where it would cut: the outline runs
 * on a quarter of the pixels with no margin, and the user's eye at
 * viewfinder size cannot vouch against a cut, so a tighter prior loses.
 * @returns { corners, confidence } — confidence from quadConfidence, plus
 *          `conservative`, the legacy crop, where the refined crop differs
 *          from it; with debug also refinement: { ...refineGivenQuad's
 *          outcome, legacy: the legacy crop, printExtent }
 */
function detectRefined(payload) {
  let img = null;
  try {
    img = cv.matFromImageData(toImageData(payload.width, payload.height, payload.buffer));
    const frame = buildFrame(img);
    const prior = payload.prior && { ...payload.prior, score: scoreQuad(frame, payload.prior.corners) };
    const legacy = detectByLegacy({ ...payload, wantSegments: true,
      chooseBest: (candidates, best) => rerankByScore(frame, candidates, best, prior) });
    let result = { corners: null };
    if (legacy.corners) {
      const lines = linePools(frame, legacy.segments);
      frame.printExtent = printedExtent(lines.all, frame);
      const outcome = refineGivenQuad(frame, legacy.corners, lines.pools);
      const corners = outcome.refined
        ? expandQuad(outcome.quad, SAFETY_MARGIN_FRACTION * frame.shortSide, frame)
        : legacy.corners;
      result = { corners, confidence: quadConfidence(outcome.score) };
      if (outcome.refined) result.conservative = legacy.corners;
      if (payload.debug) result.refinement = { ...outcome, legacy: legacy.corners, printExtent: frame.printExtent };
    }
    if (prior && !prior.score.rejected && (!result.corners ||
        (fracOutsideQuad(quadPoints(result.corners), prior.corners) <= RERANK.priorHolds &&
         scoreQuad(frame, result.corners).total - prior.score.total < RERANK.priorMargin + RERANK.priorMarginSteady * prior.stability))) {
      const confidence = quadConfidence(prior.score);
      confidence.warnings.push("prior kept");
      return { corners: prior.corners, confidence, refinement: result.refinement };
    }
    return result;
  } finally {
    releaseMats(img);
  }
}

// Which of the legacy pipeline's candidates carries on into its side
// passes. The masks' own scores read absolute contrast and area, and a
// stop of exposure can hand the win to a sheet's header band or to half of
// it; the score reads a quad against the photo — its edges, the content
// just outside them — and tells a whole sheet from a part of one. The
// score's pick must beat the legacy's clearly and must contain it: the
// score may trade a part for the whole, never the whole for a part — a
// wrong whole is loose, a wrong part is a cut. Cutting comes before the
// score: a candidate with the sheet's own print past its sides loses to
// any containing one with less of it, whatever their scores. (A field
// widened with the score engine's own mask quads, and a guarded path to a
// smaller quad, were tried: they tightened one scene and made the choice
// less stable under exposure and scale on four others, at the cost of the
// masks.)
const RERANK = Object.freeze({
  candidates: 5,           // the legacy's best few by its own score are the field
  margin: 0.05,            // over the legacy pick's score
  maxLegacyOutside: 0.1,   // "contains": this share of the legacy pick at most lies outside
  cutMargin: 0.05,         // a containing candidate wins outright when it cuts this much less
  // A camera shot's prior (detectRefined): a candidate gains its overlap
  // with the prior times priorWeight, and the detector's crop must beat the
  // prior's score by priorMargin — each plus its Steady share at full
  // stability — where the prior holds all but priorHolds of the crop.
  priorWeight: 0.15,
  priorWeightSteady: 0.35,
  priorMargin: 0.03,
  priorMarginSteady: 0.05,
  priorHolds: 0.02,
});

/** The candidate that carries on: `best` itself unless the score overrules it.
 *  @param prior a camera shot's { corners, stability }, or undefined */
function rerankByScore(frame, candidates, best, prior) {
  if (!best) return best;
  const field = candidates.filter((candidate) => candidate.corners && !candidate.rejected)
    .sort((p, q) => q.score - p.score).slice(0, RERANK.candidates);
  const priorWeight = prior ? RERANK.priorWeight + RERANK.priorWeightSteady * prior.stability : 0;
  const scored = field.map((candidate) => {
    const score = scoreQuad(frame, candidate.corners);
    // How much of its sides cut the sheet's print — the first thing ranked;
    // a quad the score cannot read at all (out of frame, not a sheet) ranks last.
    const cuts = score.rejected === "cuts" ? Math.max(...score.sides.map((side) => side.confirmedContent)) : score.rejected ? Infinity : 0;
    return { candidate, total: score.total + (priorWeight ? priorWeight * quadIoU(candidate.corners, prior.corners) : 0), cuts };
  });
  const legacy = scored.find((entry) => entry.candidate === best);
  if (!legacy || legacy.cuts === Infinity) return best; // a pick the score cannot even read stays the legacy's
  let top = legacy;
  for (const entry of scored) {
    if (entry === legacy || fracOutsideQuad(quadPoints(best.corners), entry.candidate.corners) > RERANK.maxLegacyOutside) continue;
    const cutsLess = entry.cuts <= top.cuts - RERANK.cutMargin;
    const scoresBetter = entry.cuts <= top.cuts && entry.total > top.total;
    if (cutsLess || scoresBetter) top = entry;
  }
  if (top === legacy) return best;
  return top.cuts < legacy.cuts || top.total - legacy.total >= RERANK.margin ? top.candidate : best;
}

function detect(payload) {
  return payload.engine === "refined" ? detectRefined(payload) : detectByLegacy(payload);
}

/**
 * The legacy pipeline: candidate masks (OTSU both polarities, local adaptive
 * threshold, saturation, dilated Canny at two sensitivities) each yield
 * scored quads from their outer contours; the best is corrected (reunion,
 * safe-split override); edge fusion assembles the best four sides around
 * the locks in force, an outward snap recovers any clipped strips, the net
 * catches a cut, and a small margin guarantees hairline errors never cut
 * content.
 * @param chooseBest   optional (candidates, best) => candidate — another
 *                     judge of the winning candidate, given the pipeline's
 *                     own pick; whatever it returns carries on
 * @param wantSegments also return the Hough segments (found on demand)
 * @returns { corners | null, segments? }
 */
function detectByLegacy({ width, height, buffer, wantSegments, chooseBest, skip }) {
  const pipeline = createPipeline(width, height);
  pipeline.skip = new Set(skip || []); // stages left out: reunite, split, grid, fusion, snap, net
  try {
    allocatePipelineMats(pipeline, buffer, DETECT_KERNELS);
    collectCandidates(pipeline);
    pipeline.getSegments = createSegmentSource(pipeline);
    // The printed grid, found once: it vouches for sides in buildCorners, and
    // its interior tells the sheet-colour mask what colour to look for.
    pipeline.grid = findPrintedGrid(pipeline, pipeline.getSegments(), pipeline);
    pipeline.sheetMask = pipeline.grid ? sheetColourMask(pipeline, pipeline.grid) : null;
    const candidates = pipeline.candidates;

    let best = selectBestCandidate(candidates);
    if (chooseBest) best = chooseBest(candidates, best);
    const reunion = pipeline.skip.has("reunite") ? { best, lock: null } : reuniteSeveredSection(best, pipeline);
    best = reunion.best;
    pipeline.reuniteLock = reunion.lock;
    if (!pipeline.skip.has("split")) best = applySafeSplitOverride(best, candidates);

    const corners = best ? buildCorners(best, pipeline) : null;
    return wantSegments ? { corners, segments: pipeline.getSegments() } : { corners };
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
  const pipeline = createPipeline(width, height);
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

function warp({ width, height, buffer, corners, dstW, dstH }) {
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
    return new Uint8ClampedArray(dst.data).buffer;
  } finally {
    releaseMats(src, srcTri, dstTri, transform, dst);
  }
}

// ------------------------------------------------------------------
// Message dispatch
// ------------------------------------------------------------------

/** The score breakdown of a hand-given quad, for the overlay page's tuning
 *  loop. Nothing in the app sends this. */
function scoreGivenQuad({ width, height, buffer, corners }) {
  let img = null;
  try {
    img = cv.matFromImageData(toImageData(width, height, buffer));
    const frame = buildFrame(img);
    return { score: scoreQuad(frame, corners, { keepSamples: true }),
             frame: { magnitudeScale: frame.magnitudeScale, backgroundLab: frame.backgroundLab } };
  } finally {
    releaseMats(img);
  }
}

/** One entry per message type, each returning the fields to merge into the
 *  reply plus any buffers to hand over rather than copy. A Map rather than an
 *  object literal so an unknown type can never resolve to Object.prototype. */
const HANDLERS = new Map([
  ["init", () => ({ result: {} })],
  ["detect", (payload) => ({ result: detect(payload) })],
  ["verify", ({ strips, corners, width, height }) => ({ result: verifySides(strips, corners, { width, height }) })],
  ["scoreQuad", (payload) => ({ result: scoreGivenQuad(payload) })],
  ["previewQuad", (payload) => ({ result: previewQuad(payload) })],
  ["warp", (payload) => {
    const buffer = warp(payload);
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
