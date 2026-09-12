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
 * (assembling the best four sides) and quad-refine (the anti-cut passes).
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

// Final margin, so hairline errors land on background rather than content.
const SAFETY_MARGIN_FRACTION = 0.004;

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

/** The cut chord of a winning safe split is the doc/occluder seam, and a
 *  reunion's extended sides are the severing band: both are locked against
 *  outward fusion walks and snap marches. */
function lockedSidesFor(best, reuniteLock) {
  const splitLock = best.split && best.safe && best.cutSides ? best.cutSides : [];
  if (!splitLock.length && !reuniteLock) return null;
  return new Set([...splitLock, ...(reuniteLock || [])]);
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

/** Fusion, refinement, snap and the anti-cut net, in that order. */
function buildCorners(best, pipeline, trace) {
  const { gray, width, height, candidates, getSegments } = pipeline;
  const locked = lockedSidesFor(best, pipeline.reuniteLock);
  const fuseMeta = {};
  const fused = fuseQuad(candidates, best,
    { gray, width, height, getSegments, trace, lockedTypes: locked, meta: fuseMeta });

  // refineQuadEdges returns its input unchanged without hull evidence, so this
  // needs no guard of its own — the same condition the net applies below.
  let corners = fused || refineQuadEdges(best.corners, best.hullPts, pipeline);
  corners = snapSidesOutward(pipeline, corners, locked);

  if (fused && best.hullPts && best.hullPts.length >= 3) {
    corners = applyHullCutNet(corners, {
      best, candidates, contributors: fuseMeta.contributors, locked,
      width, height, trace, rules: fuseMeta.rules,
    });
  }
  const margin = SAFETY_MARGIN_FRACTION * Math.min(width, height);
  return { corners: expandQuad(corners, margin, pipeline), fusedOk: !!fused };
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
    pipeline.kOpen, pipeline.kClose, pipeline.kDilate, pipeline.cannyEdges);
}

function detect({ width, height, buffer, debug }) {
  const pipeline = createPipeline(width, height, debug);
  try {
    allocatePipelineMats(pipeline, buffer, DETECT_KERNELS);
    collectCandidates(pipeline);
    pipeline.getSegments = createSegmentSource(pipeline);
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
 * first third of `detect` — gray, blur, the two Otsu masks — through the same
 * contour, hull and scoring code, with no fusion, refinement, snap or net.
 * Runs at a quarter of detection's pixels and two masks instead of five, so it
 * can keep up with a camera feed; the price is that it misses scenes the full
 * detector catches. It only ever draws an outline. The crop still comes from
 * `detect` on the captured photo.
 */
function previewQuad({ width, height, buffer }) {
  const pipeline = createPipeline(width, height, false);
  try {
    allocatePipelineMats(pipeline, buffer, PREVIEW_KERNELS);
    prepareGray(pipeline);
    addThresholdCandidates(pipeline, cv.THRESH_BINARY + cv.THRESH_OTSU, "otsu");
    addThresholdCandidates(pipeline, cv.THRESH_BINARY_INV + cv.THRESH_OTSU, "otsu-inv");
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
