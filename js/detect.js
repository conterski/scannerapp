/* detect.js — document corner detection, the perspective warp and capture
 * denoising, all delegated to a Web Worker (js/scan-worker.js) so the ~11 MB
 * OpenCV.js compile and this much pixel work stay off the main thread.
 * Exposes window.Detect.
 */
(function () {
  "use strict";

  // Detection runs on a downscaled copy: the heuristics are tuned for this
  // size and it keeps the worker's OpenCV heap small.
  const DETECTION_MAX_EDGE = 800;

  // A quad smaller than this share of the photo is noise, not a document.
  const MIN_DOCUMENT_AREA_FRACTION = 0.08;

  const MIN_WARP_DIMENSION = 8;
  const CORNER_KEYS = ["tl", "tr", "br", "bl"];

  let worker = null;
  let openCVReady = null;
  let lastMessageId = 0;
  const pendingCalls = new Map();

  // ---------------------------------------------------------------
  // Worker plumbing
  // ---------------------------------------------------------------

  function getWorker() {
    if (worker) return worker;
    worker = new Worker("js/scan-worker.js");
    worker.onmessage = (event) => {
      const { id, ok, error } = event.data;
      const call = pendingCalls.get(id);
      if (!call) return;
      pendingCalls.delete(id);
      ok ? call.resolve(event.data) : call.reject(new Error(error));
    };
    worker.onerror = (event) => {
      const failure = new Error(event.message || "Scan worker failed");
      pendingCalls.forEach((call) => call.reject(failure));
      pendingCalls.clear();
      // Drop the dead worker AND its ~11 MB OpenCV heap. Without terminate()
      // that heap survives until GC, on the device least able to spare it.
      worker.terminate();
      worker = null;
      openCVReady = null; // a later call rebuilds the worker from scratch
    };
    return worker;
  }

  function callWorker(type, payload, transferables) {
    return new Promise((resolve, reject) => {
      const id = ++lastMessageId;
      pendingCalls.set(id, { resolve, reject });
      getWorker().postMessage({ id, type, ...payload }, transferables || []);
    });
  }

  /** Loads OpenCV in the worker once; resolves when it is ready. */
  function ensureOpenCV() {
    if (!openCVReady) {
      openCVReady = callWorker("init");
      openCVReady.catch(() => { openCVReady = null; }); // let a later call retry
    }
    return openCVReady;
  }

  // ---------------------------------------------------------------
  // Corner detection
  // ---------------------------------------------------------------

  /**
   * Detects document corners in `sourceCanvas` (full-res normalized image).
   * Returns corners {tl,tr,br,bl} in full-res coordinates, falling back to the
   * whole image whenever no plausible document quad is found.
   */
  async function detectCorners(sourceCanvas) {
    const bounds = { width: sourceCanvas.width, height: sourceCanvas.height };
    const wholeImage = fullImageCorners(bounds.width, bounds.height);
    try {
      await ensureOpenCV();
      const { response, scale } = await runDetection(sourceCanvas, false);
      if (!response.corners) return wholeImage;
      const corners = toFullResolutionCorners(response.corners, scale, bounds);
      return isPlausibleDocumentQuad(corners, bounds) ? corners : wholeImage;
    } catch (error) {
      console.warn("Corner detection failed, using full image:", error);
      return wholeImage;
    }
  }

  /** Debug variant: returns the per-candidate scoring info at detection scale. */
  async function detectDebug(sourceCanvas) {
    await ensureOpenCV();
    const { response, scale } = await runDetection(sourceCanvas, true);
    return {
      corners: response.corners, debug: response.debug, scale,
      fusedOk: response.fusedOk, trace: response.trace,
      segments: response.segments, splitDiag: response.splitDiag,
    };
  }

  async function runDetection(sourceCanvas, wantsDebug) {
    const { canvas, scale } = ImageUtils.createScaledCanvas(sourceCanvas, DETECTION_MAX_EDGE);
    const imageData = imageDataOf(canvas);
    const response = await callWorker("detect", {
      width: imageData.width,
      height: imageData.height,
      buffer: imageData.data.buffer,
      debug: wantsDebug,
    }, [imageData.data.buffer]);
    return { response, scale };
  }

  function toFullResolutionCorners(detectedCorners, scale, bounds) {
    const corners = {};
    for (const key of CORNER_KEYS) {
      const point = detectedCorners[key];
      corners[key] = {
        x: clamp(point.x / scale, 0, bounds.width),
        y: clamp(point.y / scale, 0, bounds.height),
      };
    }
    return corners;
  }

  function isPlausibleDocumentQuad(corners, bounds) {
    return quadArea(corners) >= MIN_DOCUMENT_AREA_FRACTION * bounds.width * bounds.height;
  }

  // ---------------------------------------------------------------
  // Perspective warp
  // ---------------------------------------------------------------

  /**
   * Perspective-warps `sourceCanvas` using corners {tl,tr,br,bl} (source px)
   * into the deskewed document. A geometric transform only — pixel values are
   * untouched apart from bilinear resampling.
   *
   * `warpToImageData` is the form the enhancement wants: uploading ImageData
   * to a texture is the cheapest path onto the GPU, and building a canvas
   * first would pay for a putImageData that is then thrown away.
   *
   * @param options { maxDim } — caps the output's longest side (OpenCV
   *                downsamples straight into the smaller target, which is what
   *                Compact mode uses)
   */
  async function warpToImageData(sourceCanvas, corners, options) {
    const { maxDim } = options || {};
    await ensureOpenCV();
    const { width: dstW, height: dstH } = outputSizeFor(corners, maxDim);
    const imageData = imageDataOf(sourceCanvas);
    const response = await callWorker("warp", {
      width: imageData.width,
      height: imageData.height,
      buffer: imageData.data.buffer,
      corners: pickCorners(corners),
      dstW, dstH,
    }, [imageData.data.buffer]);

    return new ImageData(new Uint8ClampedArray(response.buffer), dstW, dstH);
  }

  async function warpPerspective(sourceCanvas, corners, options) {
    return canvasFromImageData(await warpToImageData(sourceCanvas, corners, options));
  }

  /** The deskewed page keeps the average length of each pair of opposite
   *  sides, so its proportions stay close to the real paper. */
  function outputSizeFor(corners, maxDim) {
    const { tl, tr, br, bl } = corners;
    let width = Math.max(MIN_WARP_DIMENSION,
      Math.round((distance(tl, tr) + distance(bl, br)) / 2));
    let height = Math.max(MIN_WARP_DIMENSION,
      Math.round((distance(tl, bl) + distance(tr, br)) / 2));
    const longestSide = Math.max(width, height);
    if (maxDim && longestSide > maxDim) {
      const shrink = maxDim / longestSide;
      width = Math.max(MIN_WARP_DIMENSION, Math.round(width * shrink));
      height = Math.max(MIN_WARP_DIMENSION, Math.round(height * shrink));
    }
    return { width, height };
  }

  // ---------------------------------------------------------------
  // Capture denoising
  // ---------------------------------------------------------------

  /**
   * Removes sensor grain from a camera frame, returning a new canvas of the
   * same size. `sourceCanvas` is left untouched.
   *
   * Belongs to capture rather than to scanning: it only pays off on the full
   * frame, before the capture downscale, so it runs before a photo is stored
   * rather than on the warped scan.
   */
  async function denoiseCanvas(sourceCanvas) {
    await ensureOpenCV();
    const { width, height } = sourceCanvas;
    const imageData = imageDataOf(sourceCanvas);
    const response = await callWorker("denoise", {
      width, height, buffer: imageData.data.buffer,
    }, [imageData.data.buffer]);
    return canvasFromBuffer(response.buffer, width, height);
  }

  // ---------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------

  function fullImageCorners(width, height) {
    return {
      tl: { x: 0, y: 0 },
      tr: { x: width, y: 0 },
      br: { x: width, y: height },
      bl: { x: 0, y: height },
    };
  }

  function pickCorners(corners) {
    const { tl, tr, br, bl } = corners;
    return { tl, tr, br, bl };
  }

  /** Shoelace formula over tl→tr→br→bl. */
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

  function distance(from, to) { return Math.hypot(from.x - to.x, from.y - to.y); }

  function clamp(value, low, high) { return Math.min(Math.max(value, low), high); }

  function imageDataOf(canvas) {
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  }

  /** Wraps pixels the worker handed back into a canvas. */
  function canvasFromImageData(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas;
  }

  window.Detect = {
    ensureOpenCV, detectCorners, detectDebug, warpPerspective, warpToImageData,
    denoiseCanvas, fullImageCorners,
  };
})();
