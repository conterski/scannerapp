/* frame.js — the photo as the detector reads it: blurred gray, Scharr
 * gradients, a per-image gradient scale, Lab colour and the background's
 * colour, all copied once into plain typed arrays.
 *
 * Every pixel the scorer reads goes through these arrays and never through a
 * Mat: `ucharPtr` builds a typed-array view per call, and the scorer reads
 * hundreds of thousands of pixels per photo. The Mats are released before
 * the frame is returned; only the Canny edge map, which Hough needs as a Mat,
 * stays alive until `release()`.
 *
 * Worker-global, like every worker module.
 */

const FRAME = Object.freeze({
  blurKernel: 5,               // px, the gray every probe reads

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

  canny: { low: 50, high: 150 },
});

/**
 * @param img      RGBA cv.Mat
 * @param options  { lab: bool, edges: bool } — Lab and the Canny map cost
 *                 milliseconds the preview cannot spare
 * @returns frame { width, height, shortSide, gray, dx, dy, mag,
 *                  magnitudeScale, lab|null, backgroundLab|null,
 *                  canny|null, release() }
 */
function buildFrame(img, options) {
  const wantLab = !options || options.lab !== false;
  const wantEdges = !options || options.edges !== false;
  const { cols: width, rows: height } = img;
  let gray = null, dxMat = null, dyMat = null, rgb = null, labMat = null, canny = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(FRAME.blurKernel, FRAME.blurKernel), 0);
    dxMat = new cv.Mat();
    dyMat = new cv.Mat();
    cv.Scharr(gray, dxMat, cv.CV_16S, 1, 0);
    cv.Scharr(gray, dyMat, cv.CV_16S, 0, 1);
    const dx = new Int16Array(dxMat.data16S);
    const dy = new Int16Array(dyMat.data16S);
    const mag = magnitudeOf(dx, dy);

    let lab = null;
    if (wantLab) {
      rgb = new cv.Mat();
      labMat = new cv.Mat();
      cv.cvtColor(img, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, labMat, cv.COLOR_RGB2Lab);
      lab = new Uint8Array(labMat.data);
    }
    if (wantEdges) {
      canny = new cv.Mat();
      cv.Canny(gray, canny, FRAME.canny.low, FRAME.canny.high);
    }

    const frame = {
      width, height, shortSide: Math.min(width, height),
      gray: new Uint8Array(gray.data), dx, dy, mag,
      magnitudeScale: magnitudeScaleOf(mag),
      lab, backgroundLab: null,
      canny,
      release() { if (frame.canny) { frame.canny.delete(); frame.canny = null; } },
    };
    frame.backgroundLab = lab ? backgroundColourOf(frame) : null;
    return frame;
  } catch (error) {
    if (canny) canny.delete();
    throw error;
  } finally {
    releaseMats(gray, dxMat, dyMat, rgb, labMat);
  }
}

/** |∇| in gray-step units, one JS pass: cheaper than cartToPolar plus a
 *  copy, and the orientation test needs the components, not an angle. */
function magnitudeOf(dx, dy) {
  const mag = new Float32Array(dx.length);
  for (let i = 0; i < dx.length; i++) mag[i] = Math.hypot(dx[i], dy[i]) / FRAME.scharrStepUnits;
  return mag;
}

function magnitudeScaleOf(mag) {
  const values = [];
  for (let i = 0; i < mag.length; i += FRAME.magnitudeStride) values.push(mag[i]);
  values.sort(ascending);
  const percentile = values[Math.min(values.length - 1, Math.floor(values.length * FRAME.magnitudePercentile))];
  return Math.min(FRAME.magnitudeScaleMax, Math.max(FRAME.magnitudeScaleMin, percentile));
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
// Pixel access — integer coordinates, caller keeps them inside
// ------------------------------------------------------------------

function insideFrame(frame, x, y) {
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height;
}

function pixelIndex(frame, x, y) { return y * frame.width + x; }
function labIndex(frame, x, y) { return (y * frame.width + x) * 3; }

function frameGrayAt(frame, x, y) { return frame.gray[pixelIndex(frame, x, y)]; }
function frameMagnitudeAt(frame, x, y) { return frame.mag[pixelIndex(frame, x, y)]; }

/** The gradient's share running along `normal`: 1 across the side, 0 along
 *  it. A gradient too weak to have a direction counts as none. */
function gradientAcross(frame, x, y, normal) {
  const i = pixelIndex(frame, x, y);
  const gx = frame.dx[i], gy = frame.dy[i];
  const length = Math.hypot(gx, gy);
  return length < 1 ? 0 : Math.abs(gx * normal.nx + gy * normal.ny) / length;
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
    const x = Math.round(point.x + normal.nx * depths[i]);
    const y = Math.round(point.y + normal.ny * depths[i]);
    if (!insideFrame(frame, x, y)) return null;
    values[i] = frameGrayAt(frame, x, y);
  }
  return values;
}
