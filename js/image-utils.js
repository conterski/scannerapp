/* image-utils.js — the canvas work shared by capture, decoding, detection and
 * export: scaling a source into a bounded canvas, decoding a photo with its
 * EXIF orientation applied, encoding a canvas as JPEG — and the corner-quad
 * arithmetic every module that maps a crop between resolutions needs.
 * Exposes window.ImageUtils.
 */
(function () {
  "use strict";

  // A crop is always { tl, tr, br, bl }, each an { x, y }.
  const CORNER_KEYS = ["tl", "tr", "br", "bl"];

  function clamp(value, low, high) { return Math.min(Math.max(value, low), high); }

  /** A new quad with `fn(point, key)` applied to each corner. */
  function mapCorners(corners, fn) {
    const mapped = {};
    for (const key of CORNER_KEYS) mapped[key] = fn(corners[key], key);
    return mapped;
  }

  /** Every corner scaled by `factor`. */
  function scaleCorners(corners, factor) {
    return mapCorners(corners, (point) => ({ x: point.x * factor, y: point.y * factor }));
  }

  /** Shoelace area over tl→tr→br→bl. */
  function quadArea(corners) {
    const points = CORNER_KEYS.map((key) => corners[key]);
    let doubleArea = 0;
    for (let index = 0; index < points.length; index++) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      doubleArea += current.x * next.y - next.x * current.y;
    }
    return Math.abs(doubleArea) / 2;
  }

  /** Intrinsic size of anything drawable: <img>, <video>, canvas, ImageBitmap. */
  function sourceDimensions(source) {
    return {
      width: source.naturalWidth || source.videoWidth || source.width || 0,
      height: source.naturalHeight || source.videoHeight || source.height || 0,
    };
  }

  /** Draws `source` into a new canvas whose longest side is at most `maxEdge`.
   *  Returns the applied `scale` so callers can map coordinates back.
   *  @param options { smoothing: "high" } asks for the browser's best
   *                 resample — area averaging rather than a bilinear pick,
   *                 which keeps fine print clean on the way down. Costlier,
   *                 so it is for the photo that gets kept, not for a preview
   *                 frame or a thumbnail. */
  function createScaledCanvas(source, maxEdge, options) {
    const { width, height } = sourceDimensions(source);
    // Without this the returned scale divides by zero: the caller would get an
    // Infinity scale and a 1x1 canvas instead of an error it can report.
    if (!width || !height) throw new Error("Image has no pixels");
    const requestedScale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * requestedScale));
    canvas.height = Math.max(1, Math.round(height * requestedScale));
    const context = canvas.getContext("2d");
    if (options && options.smoothing) context.imageSmoothingQuality = options.smoothing;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { canvas, scale: canvas.width / width };
  }

  function decodeViaImageElement(blob) {
    return new Promise((resolve, reject) => {
      const objectURL = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(objectURL); resolve(image); };
      image.onerror = () => {
        URL.revokeObjectURL(objectURL);
        reject(new Error("Could not decode image"));
      };
      image.src = objectURL;
    });
  }

  /** createImageBitmap applies EXIF orientation through its option; the <img>
   *  fallback gets the same orientation from the browser for free. */
  function decodeWithExifOrientation(blob) {
    return createImageBitmap(blob, { imageOrientation: "from-image" })
      .catch(() => decodeViaImageElement(blob));
  }

  /** Decoded and bounded by `maxEdge` — through the area resample, since a
   *  library photo larger than the bound is downscaled here and nowhere
   *  else: a bilinear pick leaves every thin line stair-stepped. */
  async function decodeImageToCanvas(blob, maxEdge) {
    const source = await decodeWithExifOrientation(blob);
    const { canvas } = createScaledCanvas(source, maxEdge, { smoothing: "high" });
    source.close?.();
    return canvas;
  }

  function imageDataOf(canvas) {
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  }

  /** One canvas reused for every read-back of a stream of frames — a fresh
   *  canvas per frame would be nothing but allocation churn. `context(width,
   *  height)` resizes it on demand and returns a willReadFrequently context,
   *  which keeps the pixels where getImageData can reach them without a copy
   *  off the GPU each time. */
  function createScratchCanvas() {
    let canvas = null;
    return {
      context(width, height) {
        if (!canvas) canvas = document.createElement("canvas");
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        return canvas.getContext("2d", { willReadFrequently: true });
      },
      get canvas() { return canvas; },
    };
  }

  /** An <img> for a decorative thumbnail — one that carries no alt text. */
  function thumbnailImage(url) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    return image;
  }

  /** Drops a canvas's pixel buffer now instead of at the next collection.
   *  A queued capture frame is tens of megabytes, and iOS Safari is quick to
   *  discard a tab that holds several of them waiting to be encoded. */
  function releaseCanvas(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  function encodeCanvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))),
        "image/jpeg", quality);
    });
  }

  window.ImageUtils = {
    CORNER_KEYS, clamp, mapCorners, scaleCorners, quadArea,
    sourceDimensions, createScaledCanvas, decodeImageToCanvas, encodeCanvasToJpeg,
    imageDataOf, createScratchCanvas, thumbnailImage, releaseCanvas,
  };
})();
