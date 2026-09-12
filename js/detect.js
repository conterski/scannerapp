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

  // The live viewfinder outline runs at half that again: a quarter of the
  // pixels, for something that has to keep up with a camera feed.
  const PREVIEW_MAX_EDGE = 400;

  // A quad smaller than this share of the photo is noise, not a document.
  const MIN_DOCUMENT_AREA_FRACTION = 0.08;

  const MIN_WARP_DIMENSION = 8;
  const CORNER_KEYS = ["tl", "tr", "br", "bl"];

  // The worker and its seven modules are fetched by URL rather than by a
  // <script> tag, so the deploy-time cache-busting stamp never reaches them on
  // its own. Carry this file's own stamp across by hand: without it a fresh
  // page can pair a fresh app with a stale detector, and because those modules
  // share one worker scope a half-stale set fails as a ReferenceError in the
  // middle of a detection rather than at load.
  const ASSET_VERSION = document.currentScript && document.currentScript.src
    ? new URL(document.currentScript.src).search
    : "";

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
      worker = new Worker("js/scan-worker.js" + ASSET_VERSION);
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
        const started = call("init");
        ready = started;
        // Retire this attempt only: shutDown() may already have replaced it,
        // and clearing a newer promise would send a second, pointless init.
        started.catch(() => { if (ready === started) ready = null; });
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
    // The renderer's rejection is reported at the point it is actually used.
    PromiseUtils.markRejectionHandled(renderer.ensureReady());
    return detector.ensureReady();
  }

  // ---------------------------------------------------------------
  // Corner detection
  // ---------------------------------------------------------------

  /**
   * Detects document corners in `sourceCanvas` (full-res normalized image),
   * falling back to the whole image when no plausible document quad is found
   * and when detection itself fails.
   * @param options { withoutGrid } — the overlay page's and the timing
   *                harness's switch; the app never passes it
   * @returns { corners, failed } — corners {tl,tr,br,bl} in full-res
   *          coordinates; `failed` separates the engine giving up from the
   *          photo simply having no document in it, so a caller can say so.
   */
  async function detectCorners(sourceCanvas, options) {
    const bounds = { width: sourceCanvas.width, height: sourceCanvas.height };
    const wholeImage = fullImageCorners(bounds.width, bounds.height);
    try {
      await detector.ensureReady();
      const { response, scale } = await runDetection(sourceCanvas, false, options);
      if (!response.corners) return { corners: wholeImage, failed: false };
      const corners = toFullResolutionCorners(response.corners, scale, bounds);
      const isDocument = isPlausibleDocumentQuad(corners, bounds);
      return { corners: isDocument ? corners : wholeImage, failed: false };
    } catch (error) {
      console.warn("Corner detection failed, using full image:", error);
      return { corners: wholeImage, failed: true };
    }
  }

  /** The new engine's score breakdown for `corners` (full-res), for the
   *  overlay page: how the cost function reads a quad before any search
   *  exists to find one. */
  async function scoreQuad(sourceCanvas, corners) {
    await detector.ensureReady();
    const { canvas, scale } = ImageUtils.createScaledCanvas(sourceCanvas, DETECTION_MAX_EDGE);
    const imageData = imageDataOf(canvas);
    ImageUtils.releaseCanvas(canvas);
    const scaled = {};
    for (const key of Object.keys(corners)) scaled[key] = { x: corners[key].x * scale, y: corners[key].y * scale };
    const response = await callDetector("scoreQuad", {
      width: imageData.width, height: imageData.height, buffer: imageData.data.buffer, corners: scaled,
    }, [imageData.data.buffer]);
    return { score: response.score, frame: response.frame, scale };
  }

  /** Debug variant: returns the per-candidate scoring info at detection scale.
   *  @param options { withoutGrid } — the overlay page's before/after switch */
  async function detectDebug(sourceCanvas, options) {
    await detector.ensureReady();
    const { response, scale } = await runDetection(sourceCanvas, true, options);
    return {
      corners: response.corners, debug: response.debug, scale,
      fusedOk: response.fusedOk, trace: response.trace,
      segments: response.segments, splitDiag: response.splitDiag,
      refinement: response.refinement,
    };
  }

  // ---------------------------------------------------------------
  // Live preview
  // ---------------------------------------------------------------

  // One scratch canvas for every preview frame. A fresh canvas per tick, ten
  // times a second, would be nothing but allocation churn.
  let previewCanvas = null;

  /** Draws the current frame into the scratch canvas at preview size.
   *  @returns { imageData, scale } */
  function grabPreviewFrame(frameSource) {
    const { width, height } = ImageUtils.sourceDimensions(frameSource);
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    if (!previewCanvas) previewCanvas = document.createElement("canvas");
    if (previewCanvas.width !== targetWidth || previewCanvas.height !== targetHeight) {
      previewCanvas.width = targetWidth;
      previewCanvas.height = targetHeight;
    }
    // Read back every tick, which is the case willReadFrequently exists for:
    // it keeps the pixels where getImageData can reach them without a copy
    // off the GPU each time.
    const context = previewCanvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(frameSource, 0, 0, targetWidth, targetHeight);
    return { imageData: imageDataOf(previewCanvas), scale: targetWidth / width };
  }

  /**
   * Where the document appears to be, for the live viewfinder outline — not
   * where it will be cropped. Runs on the detector, which is idle while the
   * camera is open; each call also re-arms its idle shutdown, which is what
   * keeps it warm for the whole session.
   * @param frameSource  anything drawable with a size: the <video> element
   * @returns corners {tl,tr,br,bl} in the frame's own pixels, or null when
   *          nothing plausible is in view
   */
  async function previewCorners(frameSource, options) {
    const bounds = ImageUtils.sourceDimensions(frameSource);
    if (!bounds.width || !bounds.height) return null;
    await detector.ensureReady();
    const { imageData, scale } = grabPreviewFrame(frameSource);
    const response = await callDetector("previewQuad", {
      width: imageData.width,
      height: imageData.height,
      buffer: imageData.data.buffer,
      engine: engineFor(options),
    }, [imageData.data.buffer]);
    if (!response.corners) return null;
    const corners = toFullResolutionCorners(response.corners, scale, bounds);
    return isPlausibleDocumentQuad(corners, bounds) ? corners : null;
  }

  // Which detector answers. "refined" is the legacy pipeline's crop
  // tightened by the score within a bounded, inward-only drift; "legacy" is
  // that crop alone; "score" is the generate-and-score engine on its own,
  // which the overlay page compares and the app never uses.
  const DEFAULT_ENGINE = "refined";
  function engineFor(options) { return (options && options.engine) || DEFAULT_ENGINE; }

  async function runDetection(sourceCanvas, wantsDebug, options) {
    const { canvas, scale } = ImageUtils.createScaledCanvas(sourceCanvas, DETECTION_MAX_EDGE);
    const imageData = imageDataOf(canvas);
    ImageUtils.releaseCanvas(canvas); // the pixels live in imageData now
    const response = await callDetector("detect", {
      width: imageData.width,
      height: imageData.height,
      buffer: imageData.data.buffer,
      debug: wantsDebug,
      withoutGrid: !!(options && options.withoutGrid),
      engine: engineFor(options),
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
    ensureOpenCV, detectCorners, detectDebug, scoreQuad, previewCorners, warpPerspective,
    denoiseCanvas, fullImageCorners,
  };
})();
