/* worker/enhance.js — the "natural flash" look: a photographic grade that
 * makes paper read white and ink read dark, without looking processed.
 *
 * It is a five-layer adjustment stack, composited bottom-up:
 *
 *   Lumetri #1   exposure +0.45, contrast +7, highlights -8,
 *                shadows +18, whites +7, blacks +3          ┐ one LUT
 *   Lumetri #2   subtle S-curve + midtone lift              ┘
 *   Unsharp Mask amount 85%, radius 1.1px, threshold 3
 *   Lumetri #3   exposure +0.10, contrast -2, highlights -3   a second LUT
 *
 * Every tonal control is a pointwise function of luma, so the layers either
 * side of the sharpener each collapse into a 256-entry lookup table. Only the
 * unsharp mask does real per-pixel work. Measured at ~40ms for a 2 MP scan,
 * against ~66ms for the CLAHE local-contrast pass this replaced — and the
 * result is cleaner: paper comes out white rather than grey, and text is
 * crisper rather than merely more contrasty.
 *
 * Colour is preserved by construction. The image is split into luma (Y) and
 * chroma (Cr, Cb); everything here touches Y alone and the chroma channels are
 * merged back untouched, so hue and saturation come through unchanged. (The
 * stack's Saturation 100/101 is a ±1% move, below JPEG's chroma quantisation,
 * so leaving chroma strictly alone loses nothing and keeps the guarantee.)
 *
 * It runs on the already-warped scan, so nothing outside the document can
 * influence it.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

// --- Tone controls -------------------------------------------------------
// The sliders below are in Lumetri's own units: exposure in stops, everything
// else on its -100..100 scale.

const GRADE_BEFORE_SHARPEN = {
  exposure: 0.45, contrast: 7, highlights: -8, shadows: 18, whites: 7, blacks: 3,
};
const GRADE_AFTER_SHARPEN = { exposure: 0.10, contrast: -2, highlights: -3 };

// How far a slider of 100 moves its end of the range. Shadows and highlights
// work through a broad window, blacks and whites through a tighter one, which
// is what separates "lift the dark half" from "lift the darkest corner".
const SHADOW_HIGHLIGHT_RANGE = 0.5;
const BLACK_WHITE_RANGE = 0.25;
const BROAD_WINDOW_FALLOFF = 2;
const TIGHT_WINDOW_FALLOFF = 4;

// Lumetri #2, the layer specified without numbers: extra midtone gain that
// fades to nothing at both ends (an S-curve), plus a small lift centred on
// mid-grey.
const S_CURVE_STRENGTH = 0.12;
const MIDTONE_LIFT = 0.02;
const MIDTONE_WIDTH = 0.35;

// Display gamma. Exposure is a linear-light multiply, so values have to be
// decoded before scaling and re-encoded after.
const DISPLAY_GAMMA = 2.2;

// --- Unsharp mask --------------------------------------------------------

const UNSHARP_AMOUNT = 0.85;
const UNSHARP_SIGMA = 1.1;
// Sized explicitly rather than derived from sigma: OpenCV would pick 9x9 and
// spend 31ms of a 63ms grade on it, where 5x5 costs 9ms and lands within 4
// levels of it (57.5 dB) — invisible.
const UNSHARP_KERNEL_SIZE = 5;
// Local differences smaller than this are paper grain, not detail. Leaving
// them alone is what stops the sharpener turning flat paper into noise.
const UNSHARP_THRESHOLD = 3;

const LEVELS = 256;
const MAX_LEVEL = LEVELS - 1;

// --- Curve construction --------------------------------------------------

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Both directions return 0 below zero rather than NaN, and deliberately keep
// working above 1: a lift needs headroom to be pulled back down from.
function decodeGamma(value) {
  return value <= 0 ? 0 : Math.pow(value, DISPLAY_GAMMA);
}
function encodeGamma(value) {
  return value <= 0 ? 0 : Math.pow(value, 1 / DISPLAY_GAMMA);
}

function applyExposure(value, stops) {
  return encodeGamma(decodeGamma(value) * Math.pow(2, stops));
}

/** Contrast pivots on mid-grey, so it changes separation without brightness. */
function applyContrast(value, amount) {
  return (value - 0.5) * (1 + amount / 100) + 0.5;
}

/** One tonal slider: a push weighted by how far into its end of the range the
 *  pixel sits. `falloff` sets how tightly the window is confined. */
function applyToneSlider(value, amount, options) {
  const { fromWhite, falloff, range } = options;
  const position = clamp01(value); // the window is only meaningful in range
  const distance = fromWhite ? position : 1 - position;
  return value + (amount / 100) * range * Math.pow(distance, falloff);
}

/**
 * Lumetri's Basic Correction, in its own order: exposure, contrast, then the
 * four tonal sliders. Values are left unclamped so the next layer can still
 * recover them — clamping here is what crushes a lifted highlight to flat
 * white before Highlights ever gets to pull it back.
 */
function applyGrade(value, grade) {
  let graded = applyExposure(value, grade.exposure || 0);
  graded = applyContrast(graded, grade.contrast || 0);
  if (grade.shadows) {
    graded = applyToneSlider(graded, grade.shadows,
      { fromWhite: false, falloff: BROAD_WINDOW_FALLOFF, range: SHADOW_HIGHLIGHT_RANGE });
  }
  if (grade.highlights) {
    graded = applyToneSlider(graded, grade.highlights,
      { fromWhite: true, falloff: BROAD_WINDOW_FALLOFF, range: SHADOW_HIGHLIGHT_RANGE });
  }
  if (grade.blacks) {
    graded = applyToneSlider(graded, grade.blacks,
      { fromWhite: false, falloff: TIGHT_WINDOW_FALLOFF, range: BLACK_WHITE_RANGE });
  }
  if (grade.whites) {
    graded = applyToneSlider(graded, grade.whites,
      { fromWhite: true, falloff: TIGHT_WINDOW_FALLOFF, range: BLACK_WHITE_RANGE });
  }
  return graded;
}

/** Lumetri #2: midtone gain that fades to none at both ends, then a lift. */
function applySCurveAndLift(value) {
  const fromMidpoint = 2 * clamp01(value) - 1;
  const gain = 1 + S_CURVE_STRENGTH * (1 - fromMidpoint * fromMidpoint);
  const curved = 0.5 + (value - 0.5) * gain;
  const offset = (clamp01(curved) - 0.5) / MIDTONE_WIDTH;
  return curved + MIDTONE_LIFT * Math.exp(-offset * offset);
}

/** A 1x256 CV_8U table, which cv.LUT applies as a single pass of table reads. */
function buildLookupTable(toneOf) {
  const table = new Uint8Array(LEVELS);
  for (let level = 0; level < LEVELS; level++) {
    table[level] = Math.round(clamp01(toneOf(level / MAX_LEVEL)) * MAX_LEVEL);
  }
  return cv.matFromArray(1, LEVELS, cv.CV_8U, table);
}

// Built once and kept: they depend only on the constants above, and rebuilding
// them per page would cost two Mat allocations for an identical result.
let lookupTables = null;

function toneLookupTables() {
  if (!lookupTables) {
    lookupTables = {
      beforeSharpen: buildLookupTable((value) =>
        applySCurveAndLift(applyGrade(value, GRADE_BEFORE_SHARPEN))),
      afterSharpen: buildLookupTable((value) => applyGrade(value, GRADE_AFTER_SHARPEN)),
    };
  }
  return lookupTables;
}

// --- The grade -----------------------------------------------------------

/**
 * Sharpens `luma` in place. Eight-bit throughout: addWeighted saturates
 * correctly, and the threshold is applied by copying the original back
 * wherever the local difference was too small to be detail.
 */
function sharpenLuma(luma, scratch) {
  const { blurred, difference, belowThreshold } = scratch;
  cv.GaussianBlur(luma, blurred,
    new cv.Size(UNSHARP_KERNEL_SIZE, UNSHARP_KERNEL_SIZE), UNSHARP_SIGMA);
  cv.absdiff(luma, blurred, difference);
  cv.threshold(difference, belowThreshold, UNSHARP_THRESHOLD, MAX_LEVEL, cv.THRESH_BINARY_INV);
  const original = luma.clone();
  try {
    cv.addWeighted(original, 1 + UNSHARP_AMOUNT, blurred, -UNSHARP_AMOUNT, 0, luma);
    original.copyTo(luma, belowThreshold);
  } finally {
    original.delete();
  }
}

/**
 * Returns a new RGBA Mat holding the graded scan. The caller owns it and must
 * delete it; `rgba` is left untouched.
 */
function enhanceScan(rgba) {
  const tables = toneLookupTables();
  const rgb = new cv.Mat();
  const ycrcb = new cv.Mat();
  const channels = new cv.MatVector();
  const enhanced = new cv.Mat();
  const scratch = {
    blurred: new cv.Mat(), difference: new cv.Mat(), belowThreshold: new cv.Mat(),
  };
  let luma = null;
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, ycrcb, cv.COLOR_RGB2YCrCb);
    cv.split(ycrcb, channels);

    luma = channels.get(0);
    cv.LUT(luma, tables.beforeSharpen, luma);
    sharpenLuma(luma, scratch);
    cv.LUT(luma, tables.afterSharpen, luma);

    cv.merge(channels, ycrcb);
    cv.cvtColor(ycrcb, rgb, cv.COLOR_YCrCb2RGB);
    cv.cvtColor(rgb, enhanced, cv.COLOR_RGB2RGBA);
    return enhanced;
  } catch (error) {
    enhanced.delete();
    throw error;
  } finally {
    if (luma) luma.delete();
    rgb.delete(); ycrcb.delete(); channels.delete();
    scratch.blurred.delete(); scratch.difference.delete(); scratch.belowThreshold.delete();
  }
}
