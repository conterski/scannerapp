/* detect.js — document corner detection and perspective warp, delegated to
 * a Web Worker (js/scan-worker.js) so the ~11 MB OpenCV.js compile and all
 * image processing stay off the main thread.
 * Exposes window.Detect.
 */
(function () {
  "use strict";

  let worker = null;
  let readyPromise = null;
  let msgId = 0;
  const pending = new Map();

  function getWorker() {
    if (!worker) {
      worker = new Worker("js/scan-worker.js");
      worker.onmessage = (e) => {
        const { id, ok, error } = e.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        ok ? p.resolve(e.data) : p.reject(new Error(error));
      };
      worker.onerror = (e) => {
        const err = new Error(e.message || "Scan worker failed");
        pending.forEach((p) => p.reject(err));
        pending.clear();
        worker = null;
        readyPromise = null;
      };
    }
    return worker;
  }

  function call(type, payload, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, type, ...payload }, transfer || []);
    });
  }

  /** Loads OpenCV in the worker once; resolves when ready. */
  function ensureOpenCV() {
    if (!readyPromise) {
      readyPromise = call("init");
      readyPromise.catch(() => { readyPromise = null; });
    }
    return readyPromise;
  }

  /** Draws `source` (canvas/bitmap) onto a new canvas no larger than maxDim. */
  function scaledCanvas(source, maxDim) {
    const w = source.width, h = source.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return { canvas: c, scale: c.width / w };
  }

  function imageDataOf(canvas) {
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  }

  function fullImageCorners(w, h) {
    return {
      tl: { x: 0, y: 0 },
      tr: { x: w, y: 0 },
      br: { x: w, y: h },
      bl: { x: 0, y: h },
    };
  }

  function quadArea(c) {
    // Shoelace formula over tl→tr→br→bl.
    const p = [c.tl, c.tr, c.br, c.bl];
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const q = p[(i + 1) % 4];
      a += p[i].x * q.y - q.x * p[i].y;
    }
    return Math.abs(a) / 2;
  }

  /**
   * Detects document corners in `sourceCanvas` (full-res normalized image).
   * Returns corners {tl,tr,br,bl} in full-res coordinates. Falls back to the
   * full image if no plausible document quad is found.
   */
  async function detectCorners(sourceCanvas) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const fallback = fullImageCorners(w, h);
    try {
      await ensureOpenCV();
      const { canvas: small, scale } = scaledCanvas(sourceCanvas, 800);
      const img = imageDataOf(small);
      const res = await call("detect",
        { width: img.width, height: img.height, buffer: img.data.buffer },
        [img.data.buffer]);
      if (!res.corners) return fallback;

      const clamp = (p) => ({
        x: Math.min(Math.max(p.x / scale, 0), w),
        y: Math.min(Math.max(p.y / scale, 0), h),
      });
      const corners = {
        tl: clamp(res.corners.tl),
        tr: clamp(res.corners.tr),
        br: clamp(res.corners.br),
        bl: clamp(res.corners.bl),
      };
      // Reject implausible detections (tiny quads are usually noise).
      if (quadArea(corners) < 0.08 * w * h) return fallback;
      return corners;
    } catch (err) {
      console.warn("Corner detection failed, using full image:", err);
      return fallback;
    }
  }

  /**
   * Perspective-warps `sourceCanvas` using corners {tl,tr,br,bl} (source px).
   * Returns a new canvas with the deskewed document. Geometric transform
   * only — pixel values are untouched apart from bilinear resampling.
   */
  async function warpPerspective(sourceCanvas, corners) {
    await ensureOpenCV();
    const { tl, tr, br, bl } = corners;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const dstW = Math.max(8, Math.round((dist(tl, tr) + dist(bl, br)) / 2));
    const dstH = Math.max(8, Math.round((dist(tl, bl) + dist(tr, br)) / 2));

    const img = imageDataOf(sourceCanvas);
    const res = await call("warp", {
      width: img.width,
      height: img.height,
      buffer: img.data.buffer,
      corners: { tl, tr, br, bl },
      dstW, dstH,
    }, [img.data.buffer]);

    const out = document.createElement("canvas");
    out.width = dstW;
    out.height = dstH;
    out.getContext("2d").putImageData(
      new ImageData(new Uint8ClampedArray(res.buffer), dstW, dstH), 0, 0);
    return out;
  }

  /** Debug variant: returns per-candidate scoring info at detection scale. */
  async function detectDebug(sourceCanvas) {
    await ensureOpenCV();
    const { canvas: small, scale } = scaledCanvas(sourceCanvas, 800);
    const img = imageDataOf(small);
    const res = await call("detect",
      { width: img.width, height: img.height, buffer: img.data.buffer, debug: true },
      [img.data.buffer]);
    return { corners: res.corners, debug: res.debug, scale };
  }

  window.Detect = { ensureOpenCV, detectCorners, warpPerspective, fullImageCorners, scaledCanvas, detectDebug };
})();
