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
  // measure, so a small read is enough — but too small a read blurs the
  // frames together, and a slightly soft one then ties with a sharp one.
  // 384px separates them and costs a few milliseconds per frame.
  const MEASURE_MAX_EDGE = 384;

  // A region averaging darker than this, of 255, is a black frame — a camera
  // between lenses or not yet delivering — not a dark room: even a page lit
  // by a lamp across the room reads well above it.
  const BLANK_MEAN = 4;

  // One scratch canvas for every measurement, like the preview's.
  const scratch = ImageUtils.createScratchCanvas();

  /** The gray of `imageData`, one value per pixel. */
  function grayOf(imageData) {
    const { width, height, data } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return gray;
  }

  function meanOf(gray) {
    let total = 0;
    for (let i = 0; i < gray.length; i++) total += gray[i];
    return gray.length ? total / gray.length : 0;
  }

  /** Variance of the 4-neighbour Laplacian over `gray`, `width` by `height`. */
  function laplacianVariance(gray, width, height) {
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
   * Sharpness of `region` in `source`, higher is sharper, and whether the
   * region is a blank (black) frame, which a shot must never keep.
   * @param source  anything drawImage accepts: a canvas, a video
   * @param region  { x, y, width, height } in the source's own pixels
   * @returns { sharpness, isBlank }
   */
  function assess(source, region) {
    const scale = Math.min(1, MEASURE_MAX_EDGE / Math.max(region.width, region.height));
    const width = Math.max(3, Math.round(region.width * scale));
    const height = Math.max(3, Math.round(region.height * scale));
    const context = scratch.context(width, height);
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, width, height);
    const gray = grayOf(ImageUtils.imageDataOf(scratch.canvas));
    return { sharpness: laplacianVariance(gray, width, height), isBlank: meanOf(gray) < BLANK_MEAN };
  }

  window.FrameSharpness = { assess };
})();
