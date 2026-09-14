/* frame.js — the photo as the score reads it: blurred gray, Scharr
 * gradients, a per-image gradient scale, Lab colour and the background's
 * colour, all copied once into plain typed arrays.
 *
 * Every pixel the scorer reads goes through these arrays and never through a
 * Mat: `ucharPtr` builds a typed-array view per call, and the scorer reads
 * hundreds of thousands of pixels per photo. Every Mat is released before
 * the frame is returned.
 *
 * Worker-global, like every worker module.
 */
"use strict";

const FRAME = Object.freeze({
  // The gradient scale M: a high percentile of the Scharr magnitude, in
  // gray-step units (a Scharr response of 16 is a one-level step), sampled on
  // a stride. Clamped, so one violent desk edge cannot squash paper edges to
  // nothing and a flat scene cannot inflate noise into edges.
  magnitudeStride: 4,
  magnitudePercentile: 0.97,
  magnitudeScaleMin: 10,
  magnitudeScaleMax: 40,
  scharrStepUnits: 16,

  backgroundRing: 0.04,        // of each dimension: the frame's border, mostly desk
});

/**
 * @param img  RGBA cv.Mat, the caller's to release
 * @returns frame { width, height, shortSide, scale, gray, dx, dy, mag,
 *                  magnitudeScale, lab, backgroundLab, printExtent }
 *          — scale is shortSide over SCORE.referenceShortSide, the factor
 *          every px-at-800px constant is multiplied by
 */
function buildFrame(img) {
  const { cols: width, rows: height } = img;
  let gray = null, dxMat = null, dyMat = null, rgb = null, labMat = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(BLUR_KERNEL_SIZE, BLUR_KERNEL_SIZE), 0);
    dxMat = new cv.Mat();
    dyMat = new cv.Mat();
    cv.Scharr(gray, dxMat, cv.CV_16S, 1, 0);
    cv.Scharr(gray, dyMat, cv.CV_16S, 0, 1);
    const dx = new Int16Array(dxMat.data16S);
    const dy = new Int16Array(dyMat.data16S);
    const mag = magnitudeOf(dx, dy);
    rgb = new cv.Mat();
    labMat = new cv.Mat();
    cv.cvtColor(img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, labMat, cv.COLOR_RGB2Lab);

    const shortSide = Math.min(width, height);
    const frame = {
      width, height, shortSide, scale: shortSide / SCORE.referenceShortSide,
      gray: new Uint8Array(gray.data), dx, dy, mag,
      magnitudeScale: magnitudeScaleOf(mag),
      lab: new Uint8Array(labMat.data), backgroundLab: null,
      printExtent: null, // set by the detector once the lines are known
    };
    frame.backgroundLab = backgroundColourOf(frame);
    return frame;
  } finally {
    releaseMats(gray, dxMat, dyMat, rgb, labMat);
  }
}

/** |∇| in gray-step units, one JS pass: cheaper than cartToPolar plus a
 *  copy, and the orientation test needs the components, not an angle. */
function magnitudeOf(dx, dy) {
  const mag = new Float32Array(dx.length);
  const units = FRAME.scharrStepUnits;
  for (let i = 0; i < dx.length; i++) {
    const gx = dx[i], gy = dy[i];
    mag[i] = Math.sqrt(gx * gx + gy * gy) / units;
  }
  return mag;
}

/** The percentile from a histogram in whole gray-step units — no sort of a
 *  hundred thousand values. */
function magnitudeScaleOf(mag) {
  const bins = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < mag.length; i += FRAME.magnitudeStride) {
    bins[Math.min(255, Math.round(mag[i]))]++;
    count++;
  }
  const target = count * FRAME.magnitudePercentile;
  let seen = 0, percentile = 255;
  for (let bin = 0; bin < 256; bin++) {
    seen += bins[bin];
    if (seen >= target) { percentile = bin; break; }
  }
  return clamp(percentile, FRAME.magnitudeScaleMin, FRAME.magnitudeScaleMax);
}

/** The desk: the median Lab of the frame's border ring. Robust to a document
 *  touching one edge, since the other three sides outvote it. */
function backgroundColourOf(frame) {
  const ringX = Math.max(1, Math.round(frame.width * FRAME.backgroundRing));
  const ringY = Math.max(1, Math.round(frame.height * FRAME.backgroundRing));
  const samples = [[], [], []];
  const take = (x, y) => {
    const i = labIndex(frame, x, y);
    for (let channel = 0; channel < 3; channel++) samples[channel].push(frame.lab[i + channel]);
  };
  const stride = 2;
  for (let y = 0; y < frame.height; y += stride) {
    const inTopOrBottomBand = y < ringY || y >= frame.height - ringY;
    if (inTopOrBottomBand) {
      for (let x = 0; x < frame.width; x += stride) take(x, y);
    } else {
      for (let x = 0; x < ringX; x += stride) { take(x, y); take(frame.width - 1 - x, y); }
    }
  }
  const medianOf = (values) => median(values.sort(ascending));
  return { l: medianOf(samples[0]), a: medianOf(samples[1]), b: medianOf(samples[2]) };
}

// ------------------------------------------------------------------
// Pixel access — integer coordinates, caller keeps them inside (insideBounds)
// ------------------------------------------------------------------

function pixelIndex(frame, x, y) { return y * frame.width + x; }
function labIndex(frame, x, y) { return (y * frame.width + x) * 3; }

function frameGrayAt(frame, x, y) { return frame.gray[pixelIndex(frame, x, y)]; }
function frameMagnitudeAt(frame, x, y) { return frame.mag[pixelIndex(frame, x, y)]; }

/** The gradient's component along `normal`, as a raw Scharr response. */
function gradientDot(frame, x, y, normal) {
  const i = pixelIndex(frame, x, y);
  return Math.abs(frame.dx[i] * normal.nx + frame.dy[i] * normal.ny);
}

/** The gradient's share running along `normal`: 1 across the side, 0 along
 *  it. A gradient too weak to have a direction counts as none. */
function gradientAcross(frame, x, y, normal) {
  const i = pixelIndex(frame, x, y);
  const length = Math.hypot(frame.dx[i], frame.dy[i]);
  return length < 1 ? 0 : gradientDot(frame, x, y, normal) / length;
}

/** The gradient's component along `normal`, in the frame's magnitude units. */
function gradientAlong(frame, x, y, normal) {
  return gradientDot(frame, x, y, normal) / FRAME.scharrStepUnits;
}

/** Lab at a pixel, as {l, a, b} on OpenCV's 8-bit scale (a, b offset 128). */
function frameLabAt(frame, x, y) {
  const i = labIndex(frame, x, y);
  return { l: frame.lab[i], a: frame.lab[i + 1], b: frame.lab[i + 2] };
}

/** Gray along the normal through `point`, one value per entry of `depths`
 *  (signed px, negative inward). Null when any probe leaves the frame. */
function profileAcross(frame, point, normal, depths) {
  const values = new Array(depths.length);
  for (let i = 0; i < depths.length; i++) {
    const { x, y } = alongNormal(point, normal, depths[i]);
    if (!insideBounds(frame, x, y)) return null;
    values[i] = frameGrayAt(frame, x, y);
  }
  return values;
}
