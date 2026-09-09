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

// The illumination estimate is low-frequency by construction, so the whole
// flat-field stage runs on a copy reduced to this many pixels on the short
// side and only the finished gain is scaled back up. At full resolution the
// morphological close and its wide Gaussian alone cost 2030ms of a 2900ms
// grade. Measured against docphoto_filter.py on a 6x6 sample grid: 384 gives a
// mean difference of 3.6 levels, this size 3.1 for 9% more time, and 768 gives
// 2.3 for nearly double. The residual is a smooth brightness field that the
// gain clip and flattenStrength damp further — invisible at 1% of a level.
const BACKGROUND_WORKING_EDGE = 512;

// The percentile only has to locate the paper level, so a histogram is plenty
// and avoids sorting several million floats.
const PAPER_HISTOGRAM_BINS = 1024;

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

/**
 * The illumination across the sheet: a morphological close removes the
 * writing, and a wide blur turns what is left into a smooth field.
 *
 * Returned at BACKGROUND_WORKING_EDGE rather than full size. Both the field
 * and the gain derived from it are low-frequency by construction, so the whole
 * flat-field stage runs at that size and only the finished gain is scaled back
 * up — see BACKGROUND_WORKING_EDGE and toReflectance. The caller owns the Mat.
 */
function estimateBackground(luma) {
  const fullRadius = radiusFor(DOC_PARAMS.backgroundRadius, luma) | 1;
  const scale = Math.min(1, BACKGROUND_WORKING_EDGE / Math.min(luma.rows, luma.cols));
  const background = new cv.Mat();
  let kernel = null;
  try {
    if (scale < 1) {
      cv.resize(luma, background, new cv.Size(
        Math.max(1, Math.round(luma.cols * scale)),
        Math.max(1, Math.round(luma.rows * scale))), 0, 0, cv.INTER_AREA);
    } else {
      luma.copyTo(background);
    }
    const radius = Math.max(1, Math.round(fullRadius * scale)) | 1;
    kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(radius, radius));
    cv.morphologyEx(background, background, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(background, background, new cv.Size(0, 0), radius);
    return background;
  } catch (error) {
    background.delete();
    throw error;
  } finally {
    if (kernel) kernel.delete();
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
function sharpenInk(reflectance, scratch, base) {
  guidedSelfFilter(reflectance, radiusFor(DOC_PARAMS.detailRadius, reflectance),
    DOC_PARAMS.detailEps, scratch, base);
  const { whitePoint, inkReference, detailSoftLimit, detailGain } = DOC_PARAMS;
  const inkSpan = Math.max(whitePoint - inkReference, 1e-6);
  const table = softClipTable();
  const pixels = reflectance.data32F;
  const basePixels = base.data32F;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i];
    const inkWeight = clamp01((whitePoint - value) / inkSpan);
    const detail = softClip(table, (value - basePixels[i]) / detailSoftLimit) * detailSoftLimit;
    pixels[i] = basePixels[i] + detail * (1 + detailGain * inkWeight);
  }
}

/**
 * Takes the edge off colour noise while keeping the paper's own cast and every
 * ink hue. Both channels are guided by the same reflectance, so its moments
 * are computed once and shared.
 */
function gradeChroma(channels, guide, scratch) {
  const radius = radiusFor(DOC_PARAMS.chromaRadius, guide);
  const moments = { mean: scratch.guideMean, variance: scratch.guideVariance };
  guidedMoments(guide, radius, scratch, moments);
  const { chromaDenoiseStrength: strength, chromaGain } = DOC_PARAMS;
  for (const channel of channels) {
    guidedByReference(guide, moments, channel, radius, DOC_PARAMS.chromaEps,
      scratch, scratch.filtered);
    // Blend toward the smoothed channel and apply the gain in one weighted
    // add, then clamp. Real Lab chroma sits well inside the limit, so the
    // clamp is the reference's safety net rather than something that fires.
    cv.addWeighted(channel, (1 - strength) * chromaGain,
      scratch.filtered, strength * chromaGain, 0, channel);
    clampSymmetric(channel, LAB_AB_LIMIT, scratch.tmp);
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
function applyToneCurve(reflectance, luma) {
  const { blackPoint, whitePoint, contrastShape, outputBlack, outputWhite,
    toneStrength } = DOC_PARAMS;
  const span = Math.max(whitePoint - blackPoint, 1e-6);
  const outputSpan = outputWhite - outputBlack;
  const pixels = reflectance.data32F;
  const out = luma.data32F;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i];
    const linear = clamp01((value - blackPoint) / span);
    const shaped = linear * linear * (3 - 2 * linear);
    const curved = linear + (shaped - linear) * contrastShape;
    const graded = outputBlack + curved * outputSpan;
    out[i] = clamp01(value + (graded - value) * toneStrength) * LAB_L_MAX;
  }
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

const SCRATCH_NAMES = ["tmp", "mean", "variance", "scale", "offset",
  "meanSource", "guideMean", "guideVariance", "filtered", "reflectance", "base"];

function createScratch(rows, cols) {
  const scratch = {};
  for (const name of SCRATCH_NAMES) scratch[name] = new cv.Mat(rows, cols, cv.CV_32FC1);
  return scratch;
}

function releaseScratch(scratch) {
  for (const name of SCRATCH_NAMES) scratch[name].delete();
}

/**
 * Returns a new RGBA Mat holding the enhanced scan. The caller owns it and
 * must delete it; `rgba` is left untouched.
 */
function enhanceScan(rgba) {
  const rgb = new cv.Mat();
  const floating = new cv.Mat();
  const lab = new cv.Mat();
  const channels = new cv.MatVector();
  const enhanced = new cv.Mat();
  let scratch = null;
  let background = null;
  let luma = null;
  let chromaA = null;
  let chromaB = null;
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    rgb.convertTo(floating, cv.CV_32F, 1 / 255);
    cv.cvtColor(floating, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, channels);
    luma = channels.get(0);
    chromaA = channels.get(1);
    chromaB = channels.get(2);

    scratch = createScratch(luma.rows, luma.cols);
    const { reflectance, base } = scratch;

    background = estimateBackground(luma);
    toReflectance(luma, background, scratch, reflectance);
    suppressTexture(reflectance, scratch, base);
    sharpenInk(reflectance, scratch, base);
    // Chroma is guided by the sharpened reflectance, so it must run before the
    // tone curve overwrites the luma channel.
    gradeChroma([chromaA, chromaB], reflectance, scratch);
    applyToneCurve(reflectance, luma);

    cv.merge(channels, lab);
    cv.cvtColor(lab, floating, cv.COLOR_Lab2RGB);
    floating.convertTo(rgb, cv.CV_8U, 255);
    cv.cvtColor(rgb, enhanced, cv.COLOR_RGB2RGBA);
    return enhanced;
  } catch (error) {
    enhanced.delete();
    throw error;
  } finally {
    if (luma) luma.delete();
    if (chromaA) chromaA.delete();
    if (chromaB) chromaB.delete();
    if (background) background.delete();
    if (scratch) releaseScratch(scratch);
    rgb.delete();
    floating.delete();
    lab.delete();
    channels.delete();
  }
}
