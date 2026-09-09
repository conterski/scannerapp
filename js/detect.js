/* detect.js — document corner detection, the perspective warp and capture
 * denoising, all delegated to Web Workers (js/scan-worker.js) so the ~11 MB
 * OpenCV.js compile and every pixel operation stay off the main thread.
 *
 * There are two workers, not one, because adding a batch of photos was bound
 * by a single worker doing detection, the warp and the filter in turn. They
 * are split by cost: detection on one, the warp and the filter on the other,
 * so the two halves of a batch overlap. See createWorkerChannel.
 *
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

  // ---------------------------------------------------------------
  // Worker plumbing
  // ---------------------------------------------------------------

  /**
   * One worker and everything belonging to it.
   *
   * There are two, because a batch was bound by a single worker running
   * detection, the warp and the filter one after another. Measured over five
   * pages: 1225ms of detection behind 2427ms of rendering, against a 3866ms
   * wall clock. Detection appeared to cost 3096ms inside that batch and
   * 1225ms alone — the difference was time spent queued, not working.
   */
  function createWorkerChannel() {
    let worker = null;
    let ready = null;
    let lastMessageId = 0;
    const pending = new Map();

    function getWorker() {
      if (worker) return worker;
      worker = new Worker("js/scan-worker.js");
      worker.onmessage = (event) => {
        const { id, ok, error } = event.data;
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id);
        ok ? call.resolve(event.data) : call.reject(new Error(error));
      };
      worker.onerror = (event) => {
        const failure = new Error(event.message || "Scan worker failed");
        pending.forEach((call) => call.reject(failure));
        pending.clear();
        // Drop the dead worker AND its ~11 MB OpenCV heap. Without terminate()
        // that heap survives until GC, on the device least able to spare it.
        shutDown();
      };
      return worker;
    }

    function call(type, payload, transferables) {
      return new Promise((resolve, reject) => {
        const id = ++lastMessageId;
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, type, ...payload }, transferables || []);
      });
    }

    /** Loads OpenCV in this worker once; resolves when it is ready. */
    function ensureReady() {
      if (!ready) {
        ready = call("init");
        ready.catch(() => { ready = null; }); // let a later call retry
      }
      return ready;
    }

    /** Releases the worker and its heap. A later call rebuilds it. */
    function shutDown() {
      if (!worker) return;
      worker.terminate();
      worker = null;
      ready = null;
    }

    return { call, ensureReady, shutDown, isIdle: () => pending.size === 0 };
  }

  // Detection runs at DETECTION_MAX_EDGE and never grows its worker's heap
  // past the ~128 MB the module starts with; the warp and the filter are what
  // take a worker to several hundred. Splitting them that way means the second
  // worker costs one base heap rather than a second peak.
  const detector = createWorkerChannel();
  const renderer = createWorkerChannel();

  // The detector only works while photos are being added, so its heap is given
  // back once it falls quiet. The delay is long on purpose: scanning comes in
  // bursts, and rebuilding between two batches would make the second pay for
  // an ~11 MB compile. The renderer is never shut down — adjusting a crop
  // needs it, and that is interactive.
  const DETECTOR_IDLE_SHUTDOWN_MS = 60000;
  let detectorIdleTimer = 0;

  function callDetector(type, payload, transferables) {
    clearTimeout(detectorIdleTimer);
    const finished = detector.call(type, payload, transferables);
    const rearm = () => {
      clearTimeout(detectorIdleTimer);
      detectorIdleTimer = setTimeout(() => {
        // Only when nothing is in flight, so no reply can be lost.
        if (detector.isIdle()) detector.shutDown();
      }, DETECTOR_IDLE_SHUTDOWN_MS);
    };
    finished.then(rearm, rearm);
    return finished;
  }

  /**
   * Readies the engine. Resolves on the detector, which is what runs first,
   * and starts the renderer warming without waiting for it — compiling ~11 MB
   * twice before the first photo would cost more than the overlap saves. The
   * renderer then compiles alongside the first detection and is ready well
   * before the first warp asks for it.
   */
  function ensureOpenCV() {
    markRejectionHandled(renderer.ensureReady());
    return detector.ensureReady();
  }

  /** Keeps a rejection from surfacing as unhandled; it is reported at the
   *  point the renderer is actually used. */
  function markRejectionHandled(promise) {
    promise.catch(() => {});
    return promise;
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
      await detector.ensureReady();
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
    await detector.ensureReady();
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
    const response = await callDetector("detect", {
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
   * into a new canvas holding the deskewed document. A geometric transform
   * only — pixel values are untouched apart from bilinear resampling.
   * @param options { maxDim, enhance } — `maxDim` caps the output's longest
   *                side (OpenCV downsamples straight into the smaller target,
   *                which is what Compact mode uses); `enhance` applies the
   *                natural-flash lift to the cropped scan.
   */
  async function warpPerspective(sourceCanvas, corners, options) {
    const { maxDim, enhance } = options || {};
    await renderer.ensureReady();
    const { width: dstW, height: dstH } = outputSizeFor(corners, maxDim);
    const imageData = imageDataOf(sourceCanvas);
    const response = await renderer.call("warp", {
      width: imageData.width,
      height: imageData.height,
      buffer: imageData.data.buffer,
      corners: pickCorners(corners),
      dstW, dstH, enhance: !!enhance,
    }, [imageData.data.buffer]);

    return canvasFromBuffer(response.buffer, dstW, dstH);
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
    await renderer.ensureReady();
    const { width, height } = sourceCanvas;
    const imageData = imageDataOf(sourceCanvas);
    const response = await renderer.call("denoise", {
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

  /** Wraps pixels the worker handed back into a canvas of the given size. */
  function canvasFromBuffer(buffer, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(
      new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
    return canvas;
  }

  window.Detect = {
    ensureOpenCV, detectCorners, detectDebug, warpPerspective, denoiseCanvas,
    fullImageCorners,
  };
})();
