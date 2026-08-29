/* scan-worker.js — runs OpenCV.js off the main thread and orchestrates
 * document detection.
 *
 * Protocol: postMessage({id, type, ...}) → postMessage({id, ok, ...})
 *   init   → loads OpenCV
 *   detect {width, height, buffer}                      → {corners|null}
 *   warp   {width, height, buffer, corners, dstW, dstH} → {buffer}
 *
 * The detector itself lives in worker/: geometry (pure math), pixel-probes
 * (what the pixels say), candidates (mask → scored quads), edge-fusion
 * (assembling the best four sides) and quad-refine (the anti-cut passes).
 * This file owns the pipeline that runs them in order.
 */
"use strict";

importScripts(
  "worker/geometry.js",
  "worker/pixel-probes.js",
  "worker/candidates.js",
  "worker/edge-fusion.js",
  "worker/quad-refine.js");

// Morphology: an aggressive OPEN severs thin bright bridges between the paper
// and adjacent objects (other papers, glare) so blobs don't merge.
const OPEN_KERNEL_SIZE = 13;
const CLOSE_KERNEL_SIZE = 7;
const DILATE_KERNEL_SIZE = 7;
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
    initPromise = loadOpenCV();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

async function loadOpenCV() {
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
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  try {
    cv.cvtColor(pipeline.img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    const saturation = channels.get(1);
    cv.GaussianBlur(saturation, saturation, new cv.Size(BLUR_KERNEL_SIZE, BLUR_KERNEL_SIZE), 0);
    cv.threshold(saturation, pipeline.bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cleanMask(pipeline);
    harvestMask(pipeline, "saturation");
    saturation.delete();
  } finally {
    rgb.delete(); hsv.delete(); channels.delete();
  }
}

/** Straight segments from the Canny mask BEFORE dilation — partial document
 *  edges (behind occluders, soft seams) become usable side candidates even
 *  when no mask isolates a full quad from them. */
function harvestHoughSegments(pipeline) {
  const segments = [];
  const linesMat = new cv.Mat();
  try {
    cv.HoughLinesP(pipeline.bin, linesMat, 1, Math.PI / 180, HOUGH_THRESHOLD,
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
  const segments = harvestHoughSegments(pipeline);
  cv.dilate(pipeline.bin, pipeline.bin, pipeline.kDilate);
  harvestMask(pipeline, "canny");

  cv.Canny(pipeline.gray, pipeline.bin, CANNY_SOFT_LOW, CANNY_SOFT_HIGH);
  cv.dilate(pipeline.bin, pipeline.bin, pipeline.kDilate);
  harvestMask(pipeline, "canny-soft");
  return segments;
}

function collectCandidates(pipeline) {
  cv.cvtColor(pipeline.img, pipeline.gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(pipeline.gray, pipeline.gray,
    new cv.Size(BLUR_KERNEL_SIZE, BLUR_KERNEL_SIZE), 0);

  addThresholdCandidates(pipeline, cv.THRESH_BINARY + cv.THRESH_OTSU, "otsu");
  addThresholdCandidates(pipeline, cv.THRESH_BINARY_INV + cv.THRESH_OTSU, "otsu-inv");
  addAdaptiveCandidates(pipeline);
  addSaturationCandidates(pipeline);
  return addCannyCandidates(pipeline);
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

function isWellFormedQuad(quad, width, height) {
  return quadPoints(quad).every((point) =>
    point.x >= -REUNITE_MAX_OUT_OF_FRAME * width &&
    point.x <= (1 + REUNITE_MAX_OUT_OF_FRAME) * width &&
    point.y >= -REUNITE_MAX_OUT_OF_FRAME * height &&
    point.y <= (1 + REUNITE_MAX_OUT_OF_FRAME) * height);
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
function reuniteSeveredSection(best, candidates, width, height, trace) {
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
  if (!lock.size || opposite || !isWellFormedQuad(fuller.corners, width, height)) {
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
      result = coverSide(result, protectedRegion, type, width, height);
    }
  }
  return result;
}

// ------------------------------------------------------------------
// detect
// ------------------------------------------------------------------

/** Fusion, refinement, snap and the anti-cut net, in that order. */
function buildCorners(best, pipeline, segments, trace) {
  const { gray, width, height, candidates } = pipeline;
  const locked = lockedSidesFor(best, pipeline.reuniteLock);
  const fuseMeta = {};
  const fused = fuseQuad(candidates, best,
    { gray, width, height, segments, trace, lockedTypes: locked, meta: fuseMeta });

  let corners = fused || refineQuadEdges(best.corners, best.hullPts, width, height);
  corners = snapSidesOutward(pipeline, corners, locked);

  if (fused && best.hullPts && best.hullPts.length >= 3) {
    corners = applyHullCutNet(corners, {
      best, candidates, contributors: fuseMeta.contributors, locked,
      width, height, trace, rules: fuseMeta.rules,
    });
  }
  const margin = SAFETY_MARGIN_FRACTION * Math.min(width, height);
  return { corners: expandQuad(corners, margin, width, height), fusedOk: !!fused };
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
function detect({ width, height, buffer, debug }) {
  const pipeline = {
    width, height,
    img: cv.matFromImageData(toImageData(width, height, buffer)),
    gray: new cv.Mat(),
    bin: new cv.Mat(),
    kOpen: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(OPEN_KERNEL_SIZE, OPEN_KERNEL_SIZE)),
    kClose: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE)),
    kDilate: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(DILATE_KERNEL_SIZE, DILATE_KERNEL_SIZE)),
    candidates: [],
    splitDiag: debug ? [] : null,
    reuniteLock: null,
  };
  try {
    const segments = collectCandidates(pipeline);
    const candidates = pipeline.candidates;
    const trace = debug ? [] : null;

    let best = selectBestCandidate(candidates);
    const reunion = reuniteSeveredSection(best, candidates, width, height, trace);
    best = reunion.best;
    pipeline.reuniteLock = reunion.lock;
    best = applySafeSplitOverride(best, candidates, trace);

    let corners = null;
    let fusedOk = false;
    if (best) {
      const built = buildCorners(best, pipeline, segments, trace);
      corners = built.corners;
      fusedOk = built.fusedOk;
    }

    if (!debug) return { corners };
    return {
      corners, fusedOk, trace, segments,
      splitDiag: pipeline.splitDiag,
      debug: debugPayload(candidates),
    };
  } finally {
    pipeline.img.delete(); pipeline.gray.delete(); pipeline.bin.delete();
    pipeline.kOpen.delete(); pipeline.kClose.delete(); pipeline.kDilate.delete();
  }
}

// ------------------------------------------------------------------
// warp
// ------------------------------------------------------------------

function warp({ width, height, buffer, corners, dstW, dstH }) {
  const { tl, tr, br, bl } = corners;
  const src = cv.matFromImageData(toImageData(width, height, buffer));
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
    [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, dstW, 0, dstW, dstH, 0, dstH]);
  const transform = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  try {
    // Bilinear resampling only — no filtering of pixel values.
    cv.warpPerspective(src, dst, transform, new cv.Size(dstW, dstH),
      cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return new Uint8ClampedArray(dst.data).buffer;
  } finally {
    src.delete(); srcTri.delete(); dstTri.delete(); transform.delete(); dst.delete();
  }
}

// ------------------------------------------------------------------
// Message dispatch
// ------------------------------------------------------------------

async function handleMessage({ id, type, ...payload }) {
  if (type !== "init" && type !== "detect" && type !== "warp") {
    self.postMessage({ id, ok: false, error: "Unknown message type: " + type });
    return;
  }
  await ensureInit();
  if (type === "init") {
    self.postMessage({ id, ok: true });
    return;
  }
  if (type === "detect") {
    const result = detect(payload);
    self.postMessage({ id, ok: true, corners: result.corners, debug: result.debug,
      fusedOk: result.fusedOk, trace: result.trace, segments: result.segments,
      splitDiag: result.splitDiag });
    return;
  }
  if (type === "warp") {
    const buffer = warp(payload);
    self.postMessage({ id, ok: true, buffer }, [buffer]);
  }
}

self.onmessage = (event) => {
  handleMessage(event.data).catch((error) => {
    self.postMessage({ id: event.data.id, ok: false,
      error: error && error.message ? error.message : String(error) });
  });
};
