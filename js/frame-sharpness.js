/* frame-sharpness.js — how sharp a frame is, so the capture path can keep
 * the sharpest of several. A handheld shot smears in the frames where the
 * hand moves and an autofocus sweep blurs the frames it passes through;
 * both read as a loss of fine detail, and fine detail is what the variance
 * of the Laplacian measures. The number means nothing on its own — it is
 * only ever compared between frames of the same scene.
 *
 * Exposes window.FrameSharpness.
 */
(function () {
  "use strict";

  // The region is read at this width at most. Sharpness is a relative
  // measure, so a small read is enough, and a small read keeps the cost per
  // frame well under a millisecond of the tap's latency.
  const MEASURE_MAX_EDGE = 256;

  // One scratch canvas for every measurement, like the preview's: a new
  // canvas per frame would be allocation for nothing.
  let scratch = null;

  function scratchContext(width, height) {
    if (!scratch) scratch = document.createElement("canvas");
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    return scratch.getContext("2d", { willReadFrequently: true });
  }

  /** Variance of the 4-neighbour Laplacian over the gray of `imageData`. */
  function laplacianVariance(imageData) {
    const { width, height, data } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    let sum = 0, sumOfSquares = 0, count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const value = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
        sum += value;
        sumOfSquares += value * value;
        count++;
      }
    }
    if (!count) return 0;
    const mean = sum / count;
    return sumOfSquares / count - mean * mean;
  }

  /**
   * Sharpness of `region` in `source`, higher is sharper.
   * @param source  anything drawImage accepts: a canvas, a video
   * @param region  { x, y, width, height } in the source's own pixels
   */
  function measure(source, region) {
    const scale = Math.min(1, MEASURE_MAX_EDGE / Math.max(region.width, region.height));
    const width = Math.max(3, Math.round(region.width * scale));
    const height = Math.max(3, Math.round(region.height * scale));
    const context = scratchContext(width, height);
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, width, height);
    return laplacianVariance(context.getImageData(0, 0, width, height));
  }

  window.FrameSharpness = { measure };
})();
