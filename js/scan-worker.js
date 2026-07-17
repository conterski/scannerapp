/* scan-worker.js — runs OpenCV.js + jscanify off the main thread.
 * Protocol: postMessage({id, type, ...}) → postMessage({id, ok, ...})
 *   init   → loads OpenCV + jscanify
 *   detect {width, height, buffer}                    → {corners|null}
 *   warp   {width, height, buffer, corners, dstW, dstH} → {buffer}
 */
"use strict";

let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      importScripts("../vendor/opencv.js");
      let c = self.cv;
      // Old Emscripten MODULARIZE builds expose a `.then` shim that resolves
      // with the module itself — `await cv` loops forever on that thenable.
      // Resolve our own promise with undefined and stash the module manually.
      if (c && typeof c.then === "function" && !c.Mat) {
        await new Promise((resolve) => {
          c.then((mod) => {
            if (mod && mod.Mat) self.cv = mod;
            resolve();
          });
        });
        c = self.cv;
      }
      if (c && !c.Mat) {
        await new Promise((resolve) => { c.onRuntimeInitialized = resolve; });
      }
      if (!self.cv || !self.cv.Mat) throw new Error("OpenCV failed to initialize");
      importScripts("../vendor/jscanify.min.js");
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

function toImageData(width, height, buffer) {
  return new ImageData(new Uint8ClampedArray(buffer), width, height);
}

function detect({ width, height, buffer }) {
  const mat = cv.matFromImageData(toImageData(width, height, buffer));
  try {
    const scanner = new jscanify();
    const contour = scanner.findPaperContour(mat);
    if (!contour) return null;
    try {
      const pts = scanner.getCornerPoints(contour);
      if (!pts || !pts.topLeftCorner || !pts.topRightCorner ||
          !pts.bottomRightCorner || !pts.bottomLeftCorner) return null;
      return {
        tl: pts.topLeftCorner,
        tr: pts.topRightCorner,
        br: pts.bottomRightCorner,
        bl: pts.bottomLeftCorner,
      };
    } finally {
      contour.delete();
    }
  } finally {
    mat.delete();
  }
}

function warp({ width, height, buffer, corners, dstW, dstH }) {
  const { tl, tr, br, bl } = corners;
  const src = cv.matFromImageData(toImageData(width, height, buffer));
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
    [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, dstW, 0, dstW, dstH, 0, dstH]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  try {
    // Bilinear resampling only — no filtering of pixel values.
    cv.warpPerspective(src, dst, M, new cv.Size(dstW, dstH),
      cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return new Uint8ClampedArray(dst.data).buffer;
  } finally {
    src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
  }
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "init") {
      await ensureInit();
      self.postMessage({ id, ok: true });
    } else if (type === "detect") {
      await ensureInit();
      self.postMessage({ id, ok: true, corners: detect(e.data) });
    } else if (type === "warp") {
      await ensureInit();
      const buffer = warp(e.data);
      self.postMessage({ id, ok: true, buffer }, [buffer]);
    } else {
      self.postMessage({ id, ok: false, error: "Unknown message type: " + type });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
