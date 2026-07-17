/* scan-worker.js — runs OpenCV.js off the main thread.
 * Protocol: postMessage({id, type, ...}) → postMessage({id, ok, ...})
 *   init   → loads OpenCV
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

// ------------------------------------------------------------------
// Document detection: candidate masks → scored quads → edge refinement
// ------------------------------------------------------------------

function hullPoints(hull) {
  const pts = [];
  for (let i = 0; i < hull.rows; i++) {
    pts.push({ x: hull.data32S[i * 2], y: hull.data32S[i * 2 + 1] });
  }
  return pts;
}

function internalAngles(q) {
  const p = [q.tl, q.tr, q.br, q.bl];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = p[(i + 3) % 4], b = p[i], c = p[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
    out.push(m > 0 ? (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI : 0);
  }
  return out;
}

/**
 * Collapses a convex hull to a 4-corner quad by loosening the approxPolyDP
 * epsilon until only 4 vertices remain.
 */
function quadFromHull(hull) {
  const peri = cv.arcLength(hull, true);
  for (let f = 0.02; f <= 0.121; f += 0.01) {
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(hull, approx, f * peri, true);
      if (approx.rows === 4) return orderCorners(hullPoints(approx));
      if (approx.rows < 4) return null;
    } finally {
      approx.delete();
    }
  }
  return null;
}

/**
 * Scores how document-like a candidate quad is. Bigger is NOT automatically
 * better — a solid, well-fitting quad away from the frame edges wins over a
 * huge sloppy background quad.
 */
function quadMetrics(q, contourArea, hullArea, w, h) {
  const imgArea = w * h;
  const quadArea = shoelaceArea(q);
  const areaFrac = quadArea / imgArea;
  // Corners sitting on the frame border suggest we grabbed the background.
  const m = 0.02 * Math.min(w, h);
  let borderCorners = 0;
  for (const p of [q.tl, q.tr, q.br, q.bl]) {
    if (p.x < m || p.y < m || p.x > w - m || p.y > h - m) borderCorners++;
  }

  if (areaFrac < 0.05 || areaFrac > 0.98) {
    return { score: 0, quadArea, borderCorners };
  }
  // Degenerate / sliver quads are never documents.
  const angles = internalAngles(q);
  if (angles.some((a) => a < 30 || a > 150)) {
    return { score: 0, quadArea, borderCorners };
  }

  // Solidity: merged blobs (paper + adjacent object) go L-shaped and drop.
  const solidity = hullArea > 0 ? Math.min(1, contourArea / hullArea) : 0;
  // Fit: how closely the quad matches the hull it came from.
  const fit = quadArea > 0 && hullArea > 0
    ? Math.min(quadArea, hullArea) / Math.max(quadArea, hullArea) : 0;
  const borderFactor = 1 - 0.2 * borderCorners;

  const score = Math.pow(solidity, 1.5) * fit
    * (0.6 + 0.4 * Math.sqrt(areaFrac)) * borderFactor;
  return { score, quadArea, borderCorners };
}

function bboxOf(q) {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x];
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y];
  return {
    x0: Math.min(...xs), y0: Math.min(...ys),
    x1: Math.max(...xs), y1: Math.max(...ys),
  };
}

function bboxIoU(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
}

// ---- Edge fusion: build the quad from the best individual EDGES ----

/** Sides in order: 0 top (tl→tr), 1 right (tr→br), 2 bottom (br→bl), 3 left (bl→tl). */
function sideOf(q, type) {
  return [
    { a: q.tl, b: q.tr }, { a: q.tr, b: q.br },
    { a: q.br, b: q.bl }, { a: q.bl, b: q.tl },
  ][type];
}

/**
 * How strongly the image changes across this line (0..1). A real paper edge
 * has paper on one side and background on the other; a line printed INSIDE
 * the document (table border) has paper on both sides and scores ~0.
 */
function sideContrast(gray, a, b, w, h) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 8) return 0;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const d = Math.max(6, 0.012 * Math.min(w, h));
  let sum = 0, n = 0;
  for (let t = 0.1; t <= 0.9; t += 0.05) {
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    const x1 = Math.round(px + nx * d), y1 = Math.round(py + ny * d);
    const x2 = Math.round(px - nx * d), y2 = Math.round(py - ny * d);
    if (x1 < 0 || y1 < 0 || x1 >= w || y1 >= h) continue;
    if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
    sum += Math.abs(gray.ucharPtr(y1, x1)[0] - gray.ucharPtr(y2, x2)[0]);
    n++;
  }
  return n >= 5 ? Math.min(1, sum / n / 30) : 0;
}

function lineThrough(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { px: a.x, py: a.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
}

/** Median gray level of the document's central region. */
function interiorReference(gray, q, w, h) {
  const cx = (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4;
  const cy = (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4;
  const vals = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(cx + dx * 0.05 * w), y = Math.round(cy + dy * 0.05 * h);
      if (x >= 0 && y >= 0 && x < w && y < h) vals.push(gray.ucharPtr(y, x)[0]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : 128;
}

/** True if the strip between two competing sides still looks like document. */
function bandLooksInterior(gray, inner, outer, ref, w, h) {
  let ok = 0, n = 0;
  for (let t = 0.15; t <= 0.86; t += 0.1) {
    const ax = inner.a.x + (inner.b.x - inner.a.x) * t;
    const ay = inner.a.y + (inner.b.y - inner.a.y) * t;
    const bx = outer.a.x + (outer.b.x - outer.a.x) * t;
    const by = outer.a.y + (outer.b.y - outer.a.y) * t;
    const mx = Math.round((ax + bx) / 2), my = Math.round((ay + by) / 2);
    if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
    n++;
    if (Math.abs(gray.ucharPtr(my, mx)[0] - ref) <= 30) ok++;
  }
  return n >= 4 && ok / n >= 0.6;
}

/**
 * Fuses the four document edges from across candidates: per side, prefer the
 * outermost side that shows real cross-edge contrast; sides without contrast
 * (printed tables, merge overshoot through uniform background) lose.
 */
function fuseQuad(candidates, best, gray, w, h) {
  const bestBox = bboxOf(best.corners);
  const contributors = candidates.filter((c) => !c.rejected &&
    c.score >= 0.25 * best.score && bboxIoU(bboxOf(c.corners), bestBox) >= 0.45);
  if (!contributors.length) return null;

  const interiorRef = interiorReference(gray, best.corners, w, h);
  const chosen = [];
  for (let type = 0; type < 4; type++) {
    const sides = contributors.map((c) => {
      const s = sideOf(c.corners, type);
      const mid = type % 2 === 0 ? (s.a.y + s.b.y) / 2 : (s.a.x + s.b.x) / 2;
      return {
        s,
        contrast: sideContrast(gray, s.a, s.b, w, h),
        outward: [-1, 1, 1, -1][type] * mid,
      };
    });
    const eligible = sides.filter((x) => x.contrast >= 0.5)
      .sort((a, b) => a.outward - b.outward);
    let pick;
    if (!eligible.length) {
      // No side shows real cross-edge contrast — take the least bad.
      pick = sides.reduce((a, b) => (b.contrast > a.contrast ? b : a));
    } else {
      // Walk outward from the innermost contrasted side, extending only
      // while the strip between sides still looks like the document —
      // stops merge-overshoot edges that run through the background.
      pick = eligible[0];
      for (let k = 1; k < eligible.length; k++) {
        const next = eligible[k];
        if (next.outward - pick.outward < 8 ||
            bandLooksInterior(gray, pick.s, next.s, interiorRef, w, h)) {
          pick = next;
        }
      }
    }
    chosen.push(pick);
  }

  const lines = chosen.map((p) => lineThrough(p.s.a, p.s.b));
  const pts = [
    lineIntersect(lines[3], lines[0]), // tl
    lineIntersect(lines[0], lines[1]), // tr
    lineIntersect(lines[1], lines[2]), // br
    lineIntersect(lines[2], lines[3]), // bl
  ];
  if (pts.some((p) => !p || !isFinite(p.x) || !isFinite(p.y))) return null;
  if (pts.some((p) => p.x < -0.15 * w || p.x > 1.15 * w ||
                      p.y < -0.15 * h || p.y > 1.15 * h)) return null;
  const q = orderCorners(pts);
  if (!q) return null;
  const areaFrac = shoelaceArea(q) / (w * h);
  if (areaFrac < 0.05 || areaFrac > 1.02) return null;
  const angles = internalAngles(q);
  if (angles.some((a) => a < 30 || a > 150)) return null;
  return q;
}

/** Collects scored quad candidates from every sizable outer contour of a mask. */
function candidatesFromMask(bin, w, h, out, maskName) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const areas = [];
    for (let i = 0; i < contours.size(); i++) {
      areas.push({ i, area: cv.contourArea(contours.get(i)) });
    }
    areas.sort((a, b) => b.area - a.area);
    for (const { i, area } of areas.slice(0, 5)) {
      if (area < 0.04 * w * h) break;
      const hull = new cv.Mat();
      try {
        cv.convexHull(contours.get(i), hull, false, true);
        const q = quadFromHull(hull);
        if (q) {
          const m = quadMetrics(q, area, cv.contourArea(hull), w, h);
          out.push({
            corners: q, score: m.score, quadArea: m.quadArea,
            borderCorners: m.borderCorners, rejected: m.score <= 0,
            hullPts: hullPoints(hull), mask: maskName,
          });
        } else {
          out.push({ corners: null, score: 0, rejected: true, mask: maskName,
            noQuad: true, areaFrac: area / (w * h) });
        }
      } finally {
        hull.delete();
      }
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

// ---- Edge refinement: fit a line to each paper edge, intersect them ----

function fitLinePts(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function lineIntersect(l1, l2) {
  const d = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(d) < 1e-9) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / d;
  return { x: l1.px + t * l1.dx, y: l1.py + t * l1.dy };
}

function distToSegLine(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return Infinity;
  return Math.abs((p.x - a.x) * aby - (p.y - a.y) * abx) / len;
}

/**
 * Refines a quad by assigning hull points to their nearest side, fitting a
 * straight line per side (least squares), and intersecting adjacent lines.
 * Corners come from the EDGES, so rounded or clipped hull corners don't
 * drag them inward.
 */
function refineQuadEdges(q, hullPts, w, h) {
  const corners = [q.tl, q.tr, q.br, q.bl];
  const sides = [[0, 1], [1, 2], [2, 3], [3, 0]]; // top, right, bottom, left
  const sidePts = [[], [], [], []];
  const perim = sides.reduce((s, [a, b]) => s + Math.hypot(
    corners[b].x - corners[a].x, corners[b].y - corners[a].y), 0);
  const cornerRadius = 0.05 * perim;

  for (const p of hullPts) {
    // Skip points near quad corners — rounded corners pollute edge fits.
    if (corners.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < cornerRadius)) continue;
    let best = -1, bestD = Infinity;
    for (let s = 0; s < 4; s++) {
      const d = distToSegLine(p, corners[sides[s][0]], corners[sides[s][1]]);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best >= 0 && bestD < 0.03 * perim) sidePts[best].push(p);
  }

  const lines = sides.map(([a, b], s) => {
    // Anchor each fit with the quad corners so sparse sides stay sane.
    const pts = sidePts[s].concat([corners[a], corners[b]]);
    return fitLinePts(pts);
  });

  const refined = [];
  for (let i = 0; i < 4; i++) {
    const p = lineIntersect(lines[(i + 3) % 4], lines[i]);
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return q;
    // A refined corner far outside the image means a bad fit — keep original.
    if (p.x < -0.1 * w || p.x > 1.1 * w || p.y < -0.1 * h || p.y > 1.1 * h) return q;
    refined.push(p);
  }
  return orderCorners(refined) || q;
}

/**
 * Finds the document outline. Candidate masks (OTSU both polarities, local
 * adaptive threshold, dilated Canny edges) each yield scored quads from
 * their outer contours; the best-scoring quad wins and its corners are
 * refined by edge-line fitting.
 */
function detect({ width, height, buffer, debug }) {
  const img = cv.matFromImageData(toImageData(width, height, buffer));
  const gray = new cv.Mat();
  const bin = new cv.Mat();
  // Aggressive OPEN severs thin bright bridges between the paper and
  // adjacent objects (other papers, glare) so blobs don't merge.
  const kOpen = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(13, 13));
  const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const kDilate = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const candidates = [];
  try {
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    const thresholdMask = (type, name) => {
      cv.threshold(gray, bin, 0, 255, type);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      candidatesFromMask(bin, width, height, candidates, name);
    };
    thresholdMask(cv.THRESH_BINARY + cv.THRESH_OTSU, "otsu");
    thresholdMask(cv.THRESH_BINARY_INV + cv.THRESH_OTSU, "otsu-inv");

    // Local adaptive threshold: survives shadow gradients across the paper.
    const block = Math.max(3, (Math.round(Math.min(width, height) / 6) | 1));
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C,
      cv.THRESH_BINARY, block % 2 ? block : block + 1, -4);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
    candidatesFromMask(bin, width, height, candidates, "adaptive");

    // Edge-based candidate: contrast-independent paper outline.
    cv.Canny(gray, bin, 50, 150);
    cv.dilate(bin, bin, kDilate);
    candidatesFromMask(bin, width, height, candidates, "canny");

    let best = null;
    for (const c of candidates) {
      if (c.rejected) continue;
      if (!best || c.score > best.score) best = c;
    }
    // A rectangle PRINTED ON the document (a table, a stamp box) can outscore
    // the paper itself, and threshold blobs can overshoot into background.
    // Fuse the four edges across candidates by cross-edge contrast; fall back
    // to the raw best quad if fusion fails.
    let corners = null;
    if (best) {
      corners = fuseQuad(candidates, best, gray, width, height) ||
        refineQuadEdges(best.corners, best.hullPts, width, height);
    }
    if (debug) {
      return {
        corners,
        debug: candidates.map((c) => ({
          mask: c.mask, score: +c.score.toFixed(4), rejected: !!c.rejected,
          noQuad: !!c.noQuad, areaFrac: c.areaFrac,
          corners: c.corners && {
            tl: c.corners.tl, tr: c.corners.tr, br: c.corners.br, bl: c.corners.bl,
          },
        })),
      };
    }
    return { corners };
  } finally {
    img.delete(); gray.delete(); bin.delete();
    kOpen.delete(); kClose.delete(); kDilate.delete();
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
      const res = detect(e.data);
      self.postMessage({ id, ok: true, corners: res.corners, debug: res.debug });
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
