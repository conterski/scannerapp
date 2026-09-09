/* worker/enhance.js — the "natural flash" look: a readability pass that leaves
 * the scan still looking like a photograph of paper.
 *
 * Ported from docphoto_filter.py, which is kept in the repository as the
 * reference this is checked against. Its design rules, and why each one is
 * here rather than the more obvious alternative:
 *
 *   * Lighting is evened out only PARTIALLY. The gain is clipped and then
 *     eased toward 1, so a shadowed edge keeps its own tone instead of being
 *     lifted into noise.
 *   * The tone curve has a shoulder. Paper lands just below white, so a
 *     watermark, a stamp or pale print survives instead of clipping away.
 *   * Sharpening is gated by an ink mask and soft-clipped, so flat paper gets
 *     none of it and no bright rim can form along a stroke.
 *   * Grain is attenuated, never erased. A perfectly clean field is the
 *     clearest sign that an image has been processed.
 *
 * Every radius is a fraction of the shorter side, so the same numbers apply at
 * any scan resolution.
 *
 * Colour: unlike the filter this replaced, chroma is not passed through
 * untouched — it is smoothed along with the luma and lifted 5%, which is what
 * keeps the sheet's own cast rather than bleaching it. See CRITERIA.md rule 7.
 *
 * Cost: this is an expensive filter — measured interleaved against the
 * tone-curve filter it replaces, roughly 8x its time for the same scan. Almost
 * all of it is irreducible: two float Lab conversions, three guided filters
 * and the per-pixel passes the ink mask and tone curve need. The notes on the
 * background estimate, the tanh table and guided-filter.js record where time
 * was won back; what is left is the price of the algorithm.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

// Transcribed from FilterParams in docphoto_filter.py. Radii are fractions of
// the shorter image side.
const DOC_PARAMS = Object.freeze({
  // Illumination — partial, so the original lighting character remains
  backgroundRadius: 0.030,
  paperPercentile: 90,
  gainMinimum: 0.88,
  gainMaximum: 1.18,
  flattenStrength: 0.55,

  // Texture — attenuated, not erased
  denoiseRadius: 0.003,
  denoiseEps: 8.0e-4,
  denoiseStrength: 0.55,

  // Ink sharpening
  detailRadius: 0.006,
  detailEps: 2.0e-3,
  detailGain: 0.60,
  detailSoftLimit: 0.10, // reflectance units

  // Tone — soft shoulder, no clipping at either end
  blackPoint: 0.22,
  whitePoint: 1.02,
  inkReference: 0.62, // reflectance treated as "clearly ink"
  contrastShape: 0.30, // 0 = linear, 1 = full smoothstep
  outputBlack: 0.05,
  outputWhite: 0.965,
  toneStrength: 0.85,

  // Colour
  chromaRadius: 0.006,
  chromaEps: 2.0e-3,
  chromaDenoiseStrength: 0.50,
  chromaGain: 1.05,
});

// OpenCV's float Lab: L spans 0..100, a and b are bounded well inside ±128.
const LAB_L_MAX = 100.0;
const LAB_AB_LIMIT = 110.0;
// Eight-bit Lab stores the chroma channels shifted into an unsigned range.
const LAB_AB_OFFSET = 128;

// The illumination estimate is low-frequency by construction, so the whole
// flat-field stage runs on a copy reduced to this many pixels on the short
// side and only the finished gain is scaled back up. At full resolution the
// morphological close and its wide Gaussian alone cost 2030ms of a 2900ms
// grade. Measured against docphoto_filter.py on a 6x6 sample grid: 384 gives a
// mean difference of 3.6 levels, this size 3.1 for 9% more time, and 768 gives
// 2.3 for nearly double. The residual is a smooth brightness field that the
// gain clip and flattenStrength damp further — invisible at 1% of a level.
const BACKGROUND_WORKING_EDGE = 512;

// Enough box blurs to pass for a Gaussian without any of them being wide.
const BOX_BLUR_PASSES = 3;

// Chroma is denoised, not resolved, so its guided filter runs at a quarter of
// each side. See gradeChroma.
const CHROMA_DIVISOR = 4;

// The percentile only has to locate the paper level, so a histogram is plenty
// and avoids sorting several million floats.
const PAPER_HISTOGRAM_BINS = 1024;

// The soft clip is applied over this range of detail either side of zero.
// tanh has flattened by three times the soft limit, so this covers it.
const DETAIL_RANGE = 0.35;

// tanh is the one transcendental in the pipeline and it runs per pixel:
// Math.tanh costs 29ms per 2 MP against 6ms for an interpolated table, which
// tracks it to 8.4e-7 — far below a level of output.
const TANH_TABLE_LIMIT = 6;
const TANH_TABLE_BINS = 4096;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ------------------------------------------------------------------
// tanh table
// ------------------------------------------------------------------

let tanhTable = null;

function softClipTable() {
  if (!tanhTable) {
    const values = new Float32Array(TANH_TABLE_BINS + 1);
    for (let bin = 0; bin <= TANH_TABLE_BINS; bin++) {
      values[bin] = Math.tanh(-TANH_TABLE_LIMIT +
        (2 * TANH_TABLE_LIMIT * bin) / TANH_TABLE_BINS);
    }
    tanhTable = { values, scale: TANH_TABLE_BINS / (2 * TANH_TABLE_LIMIT) };
  }
  return tanhTable;
}

/** tanh(value), read from the table with linear interpolation. */
function softClip(table, value) {
  if (value <= -TANH_TABLE_LIMIT) return -1;
  if (value >= TANH_TABLE_LIMIT) return 1;
  const position = (value + TANH_TABLE_LIMIT) * table.scale;
  const bin = position | 0;
  const fraction = position - bin;
  const low = table.values[bin];
  return low + (table.values[bin + 1] - low) * fraction;
}

// ------------------------------------------------------------------
// Stages
// ------------------------------------------------------------------

function radiusFor(fraction, mat) {
  return Math.max(1, Math.round(fraction * Math.min(mat.rows, mat.cols)));
}

/** Three box blurs converge on a Gaussian. Matching the variance of the sum,
 *  sigma^2 = 3(w^2-1)/12, gives this width — about twice sigma. */
function boxBlurWidthFor(sigma) {
  return Math.max(1, Math.round(Math.sqrt(4 * sigma * sigma + 1))) | 1;
}

/**
 * The illumination across the sheet: a close removes the writing, and a wide
 * blur turns what is left into a smooth field.
 *
 * Returned at BACKGROUND_WORKING_EDGE rather than full size. Both the field
 * and the gain derived from it are low-frequency by construction, so the whole
 * flat-field stage runs at that size and only the finished gain is scaled back
 * up — see BACKGROUND_WORKING_EDGE and toReflectance. The caller owns the Mat.
 *
 * Two departures from the reference, both to stop this stage dominating the
 * filter — it measured 352ms of a 1263ms grade, more than any other:
 *
 *   * A square structuring element rather than an ellipse. A square close
 *     separates into a row pass and a column pass: 42ms against 236ms, for a
 *     root-mean-square difference of 0.43 in L.
 *   * Three box blurs rather than a Gaussian. OpenCV sizes a float Gaussian
 *     to +/-4 sigma, 137 taps here, and costs 79ms where the boxes cost 7ms
 *     for an RMS difference of 0.41.
 *
 * Both differences land on a field that is then clipped to the gain limits and
 * halved again by flattenStrength, so well under 1% of brightness survives
 * into the image. The GPU port used the same square close and measured closer
 * to docphoto_filter.py than the ellipse did.
 */
function estimateBackground(luma) {
  const fullRadius = radiusFor(DOC_PARAMS.backgroundRadius, luma) | 1;
  const scale = Math.min(1, BACKGROUND_WORKING_EDGE / Math.min(luma.rows, luma.cols));
  let current = new cv.Mat();
  let spare = new cv.Mat();
  let rowKernel = null;
  let columnKernel = null;
  try {
    if (scale < 1) {
      cv.resize(luma, current, new cv.Size(
        Math.max(1, Math.round(luma.cols * scale)),
        Math.max(1, Math.round(luma.rows * scale))), 0, 0, cv.INTER_AREA);
    } else {
      luma.copyTo(current);
    }
    const radius = Math.max(1, Math.round(fullRadius * scale)) | 1;
    rowKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(radius, 1));
    columnKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, radius));

    // Neither morphology nor blur is safe in place, so every pass writes into
    // the spare and the two swap. Routing them all through one helper keeps
    // the swap in a single place rather than repeated seven times.
    const pass = (operate) => {
      operate(current, spare);
      const swap = current;
      current = spare;
      spare = swap;
    };

    // Close = dilate then erode, each separated into a row and a column pass.
    pass((source, target) => cv.dilate(source, target, rowKernel));
    pass((source, target) => cv.dilate(source, target, columnKernel));
    pass((source, target) => cv.erode(source, target, rowKernel));
    pass((source, target) => cv.erode(source, target, columnKernel));

    const width = boxBlurWidthFor(radius);
    const blurSize = new cv.Size(width, width);
    for (let blur = 0; blur < BOX_BLUR_PASSES; blur++) {
      pass((source, target) => cv.blur(source, target, blurSize));
    }

    spare.delete();
    return current;
  } catch (error) {
    current.delete();
    spare.delete();
    throw error;
  } finally {
    if (rowKernel) rowKernel.delete();
    if (columnKernel) columnKernel.delete();
  }
}

/** The brightness the clean paper sits at, as a percentile of the background. */
function paperLevelOf(background) {
  const pixels = background.data32F;
  const histogram = new Uint32Array(PAPER_HISTOGRAM_BINS);
  const lastBin = PAPER_HISTOGRAM_BINS - 1;
  for (let i = 0; i < pixels.length; i++) {
    const bin = (pixels[i] / LAB_L_MAX) * lastBin;
    histogram[bin < 0 ? 0 : bin > lastBin ? lastBin : bin | 0]++;
  }
  const target = (DOC_PARAMS.paperPercentile / 100) * pixels.length;
  let seen = 0;
  for (let bin = 0; bin < PAPER_HISTOGRAM_BINS; bin++) {
    seen += histogram[bin];
    if (seen >= target) return (bin / lastBin) * LAB_L_MAX;
  }
  return LAB_L_MAX;
}

/**
 * Expresses each pixel relative to clean paper, correcting the lighting only
 * partially: the gain is clipped and then eased toward 1, so shading is
 * softened rather than erased and the desk is never lifted into noise.
 *
 * The gain is derived at the background's own reduced size and then scaled up.
 * It is a smooth function of a smooth field, so nothing is lost by it, and it
 * turns the one genuinely per-pixel step here into a single multiply — worth
 * doing because a pass over the pixel data costs ~35ms per 2 MP in this build
 * where cv.multiply costs ~2.6ms.
 */
function toReflectance(luma, background, scratch, destination) {
  const paperLevel = paperLevelOf(background);
  const { gainMinimum, gainMaximum, flattenStrength } = DOC_PARAMS;
  const gain = background.data32F;
  for (let i = 0; i < gain.length; i++) {
    let value = paperLevel / Math.max(gain[i], 1);
    if (value < gainMinimum) value = gainMinimum;
    else if (value > gainMaximum) value = gainMaximum;
    gain[i] = 1 + (value - 1) * flattenStrength;
  }
  cv.resize(background, scratch.tmp, new cv.Size(luma.cols, luma.rows), 0, 0, cv.INTER_LINEAR);
  cv.multiply(luma, scratch.tmp, destination, 1 / Math.max(paperLevel, 1));
}

/** Attenuates grain, leaving enough that the scan still reads as a photo. */
function suppressTexture(reflectance, scratch, smoothed) {
  const strength = DOC_PARAMS.denoiseStrength;
  guidedSelfFilter(reflectance, radiusFor(DOC_PARAMS.denoiseRadius, reflectance),
    DOC_PARAMS.denoiseEps, scratch, smoothed);
  cv.addWeighted(reflectance, 1 - strength, smoothed, strength, 0, reflectance);
}

/**
 * Edge-aware detail boost restricted to ink. The ink weight is 1 on a stroke,
 * 0 on clean paper and smooth between; the detail is soft-clipped before it is
 * amplified, which is what prevents an overshoot rim along an edge.
 *
 * Fused into one pass: the mask is only ever read once, immediately, so
 * building it as a separate image would cost a full-size allocation and
 * another traversal for nothing.
 */
/** The soft clip as a 256-entry table over the detail's own range.
 *
 *  tanh saturates well before the edges of this range, so anything beyond it
 *  is already flat and convertTo's saturation handles it correctly. */
let detailTable = null;

function detailLookupTable() {
  if (!detailTable) {
    const limit = DOC_PARAMS.detailSoftLimit;
    const entries = new Uint8Array(TONE_TABLE_ENTRIES);
    for (let level = 0; level < TONE_TABLE_ENTRIES; level++) {
      const detail = (level / TONE_TABLE_MAX) * 2 * DETAIL_RANGE - DETAIL_RANGE;
      const clipped = Math.tanh(detail / limit) * limit;
      entries[level] = Math.round((clipped + limit) / (2 * limit) * TONE_TABLE_MAX);
    }
    detailTable = cv.matFromArray(1, TONE_TABLE_ENTRIES, cv.CV_8U, entries);
  }
  return detailTable;
}

/**
 * Edge-aware detail boost restricted to ink. The ink weight is 1 on a stroke,
 * 0 on clean paper and smooth between; the detail is soft-clipped before it is
 * amplified, which is what prevents an overshoot rim along an edge.
 *
 * Written as whole-image operations rather than a pass over the pixel data: a
 * pass costs ~35ms per 2 MP in this build where a cv operation costs ~3ms, and
 * this stage ran a pass over every pixel. The soft clip is the one nonlinear
 * step and it becomes a table, the same trick the tone curve uses.
 */
function sharpenInk(reflectance, scratch, base) {
  guidedSelfFilter(reflectance, radiusFor(DOC_PARAMS.detailRadius, reflectance),
    DOC_PARAMS.detailEps, scratch, base);
  const { whitePoint, inkReference, detailSoftLimit: limit, detailGain } = DOC_PARAMS;
  const inkSpan = Math.max(whitePoint - inkReference, 1e-6);

  // detail = softClip(reflectance - base), through the table.
  cv.subtract(reflectance, base, scratch.tmp);
  scratch.tmp.convertTo(scratch.quantised, cv.CV_8U,
    TONE_TABLE_MAX / (2 * DETAIL_RANGE), TONE_TABLE_MAX / 2);
  cv.LUT(scratch.quantised, detailLookupTable(), scratch.quantised);
  scratch.quantised.convertTo(scratch.tmp, cv.CV_32F, 2 * limit / TONE_TABLE_MAX, -limit);

  // weight = 1 + detailGain * clamp((whitePoint - reflectance) / inkSpan, 0, 1)
  reflectance.convertTo(scratch.mean, cv.CV_32F, -1 / inkSpan, whitePoint / inkSpan);
  cv.threshold(scratch.mean, scratch.mean, 1, 0, cv.THRESH_TRUNC);
  cv.threshold(scratch.mean, scratch.mean, 0, 0, cv.THRESH_TOZERO);
  scratch.mean.convertTo(scratch.mean, cv.CV_32F, detailGain, 1);

  cv.multiply(scratch.tmp, scratch.mean, scratch.tmp);
  cv.add(base, scratch.tmp, reflectance);
}

/**
 * Takes the edge off colour noise while keeping the paper's own cast and every
 * ink hue. Both channels are guided by the same reflectance, so its moments
 * are computed once and shared.
 */
/**
 * Takes the edge off colour noise while keeping the paper's own cast and every
 * ink hue. Both channels are guided by the same reflectance, so its moments
 * are computed once and shared.
 *
 * Run at a quarter of each side. This stage is denoising colour, and the eye
 * carries little colour detail — JPEG subsamples chroma more coarsely than
 * this. Measured against the full-resolution result the difference is 0.128
 * mean, and it costs 43ms rather than 251ms while keeping four full-size float
 * buffers out of the peak.
 */
function gradeChroma(channels, guide, fullScratch) {
  const width = Math.max(8, Math.round(guide.cols / CHROMA_DIVISOR));
  const height = Math.max(8, Math.round(guide.rows / CHROMA_DIVISOR));
  const size = new cv.Size(width, height);
  const fullSize = new cv.Size(guide.cols, guide.rows);
  const radius = Math.max(1, Math.round(radiusFor(DOC_PARAMS.chromaRadius, guide) / CHROMA_DIVISOR));

  const scratch = createScratch(height, width);
  const smallGuide = new cv.Mat();
  const smallChannel = new cv.Mat();
  try {
    cv.resize(guide, smallGuide, size, 0, 0, cv.INTER_AREA);
    const moments = { mean: scratch.guideMean, variance: scratch.guideVariance };
    guidedMoments(smallGuide, radius, scratch, moments);
    const { chromaDenoiseStrength: strength, chromaGain } = DOC_PARAMS;
    for (const channel of channels) {
      cv.resize(channel, smallChannel, size, 0, 0, cv.INTER_AREA);
      guidedByReference(smallGuide, moments, smallChannel, radius,
        DOC_PARAMS.chromaEps, scratch, scratch.filtered);
      // Blend toward the smoothed channel and apply the gain in one weighted
      // add, then clamp. Real Lab chroma sits well inside the limit, so the
      // clamp is the reference's safety net rather than something that fires.
      cv.addWeighted(smallChannel, (1 - strength) * chromaGain,
        scratch.filtered, strength * chromaGain, 0, smallChannel);
      clampSymmetric(smallChannel, LAB_AB_LIMIT, scratch.tmp);
      cv.resize(smallChannel, channel, fullSize, 0, 0, cv.INTER_LINEAR);
    }
  } finally {
    smallGuide.delete();
    smallChannel.delete();
    releaseScratch(scratch);
  }
}

/** Constrains a signed channel to +/- limit, in place. THRESH_TRUNC only caps
 *  from above, so the lower bound is the same cap applied to the negation. */
function clampSymmetric(channel, limit, scratch) {
  cv.threshold(channel, channel, limit, 0, cv.THRESH_TRUNC);
  channel.convertTo(scratch, -1, -1, 0);
  cv.threshold(scratch, scratch, limit, 0, cv.THRESH_TRUNC);
  scratch.convertTo(channel, -1, -1, 0);
}

/**
 * Gentle levels with a partial smoothstep, landing inside a safe output range
 * so neither end clips, then blended back toward the input. Writes the result
 * straight into the luma channel as Lab L.
 */
/** The tone curve at one reflectance value, in 0..1. */
function toneAt(value) {
  const { blackPoint, whitePoint, contrastShape, outputBlack, outputWhite,
    toneStrength } = DOC_PARAMS;
  const span = Math.max(whitePoint - blackPoint, 1e-6);
  const linear = clamp01((value - blackPoint) / span);
  const shaped = linear * linear * (3 - 2 * linear);
  const curved = linear + (shaped - linear) * contrastShape;
  const graded = outputBlack + curved * (outputWhite - outputBlack);
  return clamp01(value + (graded - value) * toneStrength);
}

// Reflectance is paper-relative, so it runs from 0 to a little over 1; this
// covers it with headroom. Values above land on the last entry, where the
// curve has already flattened.
const TONE_INPUT_RANGE = 1.6;
const TONE_TABLE_ENTRIES = 256;
const TONE_TABLE_MAX = TONE_TABLE_ENTRIES - 1;

let toneTable = null;

/** The curve as a 256-entry table. It depends only on the parameters, so it
 *  is built once, like the soft-clip table above. */
function toneLookupTable() {
  if (!toneTable) {
    const entries = new Uint8Array(TONE_TABLE_ENTRIES);
    for (let level = 0; level < TONE_TABLE_ENTRIES; level++) {
      const reflectance = (level / TONE_TABLE_MAX) * TONE_INPUT_RANGE;
      entries[level] = Math.round(toneAt(reflectance) * TONE_TABLE_MAX);
    }
    toneTable = cv.matFromArray(1, TONE_TABLE_ENTRIES, cv.CV_8U, entries);
  }
  return toneTable;
}

/**
 * Gentle levels with a partial smoothstep, landing inside a safe output range
 * so neither end clips, then blended back toward the input.
 *
 * Applied as a table rather than per pixel: it is pointwise, and quantising
 * the input to 256 steps costs 0.42 levels of a result that is written to an
 * 8-bit channel anyway — for 16ms against 60ms.
 */
function applyToneCurve(reflectance, scratch, luma) {
  reflectance.convertTo(scratch.quantised, cv.CV_8U, TONE_TABLE_MAX / TONE_INPUT_RANGE);
  cv.LUT(scratch.quantised, toneLookupTable(), scratch.quantised);
  scratch.quantised.convertTo(luma, cv.CV_32F, LAB_L_MAX / TONE_TABLE_MAX);
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

const SCRATCH_NAMES = ["tmp", "mean", "variance", "scale", "offset",
  "meanSource", "guideMean", "guideVariance", "filtered", "reflectance", "base"];

// The tone curve reads and writes eight-bit data, so its buffer is the one
// member of the set that is not float.
const QUANTISED_SCRATCH = "quantised";

function createScratch(rows, cols) {
  const scratch = {};
  for (const name of SCRATCH_NAMES) scratch[name] = new cv.Mat(rows, cols, cv.CV_32FC1);
  scratch[QUANTISED_SCRATCH] = new cv.Mat(rows, cols, cv.CV_8UC1);
  return scratch;
}

function releaseScratch(scratch) {
  for (const name of SCRATCH_NAMES) scratch[name].delete();
  scratch[QUANTISED_SCRATCH].delete();
}

/**
 * Returns a new RGBA Mat holding the enhanced scan. The caller owns it and
 * must delete it; `rgba` is left untouched.
 */
/**
 * Splits the photo into Lab planes, as float, ready to grade.
 *
 * The Lab transform runs on eight-bit data and each plane is floated
 * afterwards, rather than floating the whole image first. OpenCV's float Lab
 * costs 142ms where the eight-bit one costs 22ms, and a round trip through
 * eight-bit Lab differs from a float one by 0.41 levels on average — below
 * what the eight-bit output quantises to anyway. It also never builds the two
 * three-channel float images, which are 112MB between them on a 2500px scan.
 *
 * @returns [luma, a, b] as CV_32FC1; the caller owns all three
 */
function toLabPlanes(rgba) {
  const rgb = new cv.Mat();
  const lab = new cv.Mat();
  const planes = new cv.MatVector();
  const floated = [];
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, planes);
    // Eight-bit Lab packs L into 0..255 and the chroma channels around an
    // offset of 128; both are restored to the ranges the grade works in.
    for (let index = 0; index < 3; index++) {
      const plane = planes.get(index);
      const target = new cv.Mat();
      if (index === 0) plane.convertTo(target, cv.CV_32F, LAB_L_MAX / 255);
      else plane.convertTo(target, cv.CV_32F, 1, -LAB_AB_OFFSET);
      plane.delete();
      floated.push(target);
    }
    return floated;
  } catch (error) {
    floated.forEach((plane) => plane.delete());
    throw error;
  } finally {
    rgb.delete();
    lab.delete();
    planes.delete();
  }
}

/** The inverse of toLabPlanes: graded planes back to an RGBA image.
 *
 *  Each plane needs its own eight-bit Mat. A MatVector shares the pixel data
 *  of what it is given, so reusing one buffer across the three push_backs
 *  would leave all three channels pointing at whichever was written last.
 *  Eight-bit planes are a byte a pixel, so three of them cost little. */
function fromLabPlanes(planes) {
  const lab = new cv.Mat();
  const rgb = new cv.Mat();
  const eightBit = new cv.MatVector();
  const converted = [];
  const enhanced = new cv.Mat();
  try {
    for (let index = 0; index < 3; index++) {
      const plane = new cv.Mat();
      if (index === 0) planes[index].convertTo(plane, cv.CV_8U, 255 / LAB_L_MAX);
      else planes[index].convertTo(plane, cv.CV_8U, 1, LAB_AB_OFFSET);
      converted.push(plane);
      eightBit.push_back(plane);
    }
    cv.merge(eightBit, lab);
    cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
    cv.cvtColor(rgb, enhanced, cv.COLOR_RGB2RGBA);
    return enhanced;
  } catch (error) {
    enhanced.delete();
    throw error;
  } finally {
    converted.forEach((plane) => plane.delete());
    lab.delete();
    rgb.delete();
    eightBit.delete();
  }
}

/**
 * Returns a new RGBA Mat holding the graded scan. The caller owns it and must
 * delete it; `rgba` is left untouched.
 */
function enhanceScan(rgba) {
  let planes = null;
  let scratch = null;
  let background = null;
  try {
    planes = toLabPlanes(rgba);
    const [luma, chromaA, chromaB] = planes;

    scratch = createScratch(luma.rows, luma.cols);
    const { reflectance, base } = scratch;

    background = estimateBackground(luma);
    toReflectance(luma, background, scratch, reflectance);
    background.delete();
    background = null;

    suppressTexture(reflectance, scratch, base);
    sharpenInk(reflectance, scratch, base);
    // Chroma is guided by the sharpened reflectance, so it must run before the
    // tone curve overwrites the luma plane.
    gradeChroma([chromaA, chromaB], reflectance, scratch);
    applyToneCurve(reflectance, scratch, luma);

    // The grade is finished and only the three planes are still needed, so the
    // working set goes back before the output is assembled rather than being
    // held alongside it.
    releaseScratch(scratch);
    scratch = null;
    return fromLabPlanes(planes);
  } finally {
    if (background) background.delete();
    if (scratch) releaseScratch(scratch);
    if (planes) planes.forEach((plane) => plane.delete());
  }
}
