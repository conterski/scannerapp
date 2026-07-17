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
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

function toImageData(width, height, buffer) {
  return new ImageData(new Uint8ClampedArray(buffer), width, height);
}

function shoelaceArea(q) {
  const p = [q.tl, q.tr, q.br, q.bl];
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const n = p[(i + 1) % 4];
    a += p[i].x * n.y - n.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

function orderCorners(pts) {
  let tl, tr, br, bl;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const p of pts) {
    const s = p.x + p.y, d = p.x - p.y;
    if (s < minSum) { minSum = s; tl = p; }
    if (s > maxSum) { maxSum = s; br = p; }
    if (d > maxDiff) { maxDiff = d; tr = p; }
    if (d < minDiff) { minDiff = d; bl = p; }
  }
  if (new Set([tl, tr, br, bl]).size !== 4) return null;
  return { tl, tr, br, bl };
}

/**
 * From a binary mask, takes the LARGEST OUTERMOST contour (interior detail
 * like printed tables or text can never win) and fits a quadrilateral to
 * its convex hull — i.e. to the paper's four edges.
 */
function largestExternalQuad(bin, imgArea) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let idx = -1, maxA = 0;
    for (let i = 0; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > maxA) { maxA = a; idx = i; }
    }
    if (idx < 0) return null;
    const hull = new cv.Mat();
    try {
      cv.convexHull(contours.get(idx), hull, false, true);
      const peri = cv.arcLength(hull, true);
      // Loosen epsilon until the hull collapses to 4 corners.
      for (let f = 0.02; f <= 0.121; f += 0.01) {
        const approx = new cv.Mat();
        try {
          cv.approxPolyDP(hull, approx, f * peri, true);
          if (approx.rows === 4) {
            const pts = [];
            for (let i = 0; i < 4; i++) {
              pts.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
            }
            const q = orderCorners(pts);
            if (!q) return null;
            const area = shoelaceArea(q);
            // Reject noise quads and near-full-frame quads (background blob).
            if (area < 0.08 * imgArea || area > 0.97 * imgArea) return null;
            return { corners: q, area };
          }
        } finally {
          approx.delete();
        }
      }
      return null;
    } finally {
      hull.delete();
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * Finds the document's outline. Three candidate masks — bright-paper OTSU,
 * inverted OTSU (dark document on light surface), and dilated Canny edges —
 * each reduced to their largest external quad; the biggest plausible one wins.
 */
function detect({ width, height, buffer }) {
  const img = cv.matFromImageData(toImageData(width, height, buffer));
  const gray = new cv.Mat();
  const bin = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const imgArea = width * height;
  const candidates = [];
  try {
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
    candidates.push(largestExternalQuad(bin, imgArea));

    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
    candidates.push(largestExternalQuad(bin, imgArea));

    cv.Canny(gray, bin, 50, 150);
    cv.dilate(bin, bin, kernel);
    candidates.push(largestExternalQuad(bin, imgArea));

    let best = null;
    for (const c of candidates) {
      if (c && (!best || c.area > best.area)) best = c;
    }
    return best ? best.corners : null;
  } finally {
    img.delete(); gray.delete(); bin.delete(); kernel.delete();
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
