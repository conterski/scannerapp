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
 * A pentagon is usually a document with one corner truncated (occluded by
 * another paper). Reconstruct the quad: drop one side, extend its neighbors
 * to their intersection. The right drop yields a clean near-parallelogram;
 * score reconstructions by area x opposite-side parallelism.
 */
function pentagonToQuad(pts) {
  const dirOf = (p1, p2) => Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const angDiff = (u, v) => {
    const d = Math.abs(u - v) % Math.PI;
    return Math.min(d, Math.PI - d);
  };
  let best = null, bestScore = 0;
  for (let drop = 0; drop < 5; drop++) {
    // Side dropped: pts[drop] → pts[drop+1]. Extend the two adjacent sides.
    const prevLine = lineThrough(pts[(drop + 4) % 5], pts[drop]);
    const nextLine = lineThrough(pts[(drop + 2) % 5], pts[(drop + 1) % 5]);
    const x = lineIntersect(prevLine, nextLine);
    if (!x || !isFinite(x.x) || !isFinite(x.y)) continue;
    const q = orderCorners([x, pts[(drop + 2) % 5], pts[(drop + 3) % 5], pts[(drop + 4) % 5]]);
    if (!q) continue;
    const angles = internalAngles(q);
    if (angles.some((an) => an < 35 || an > 145)) continue;
    const par = Math.max(0, 1 -
      (angDiff(dirOf(q.tl, q.tr), dirOf(q.bl, q.br)) +
       angDiff(dirOf(q.tl, q.bl), dirOf(q.tr, q.br))) / (30 * Math.PI / 180));
    const score = shoelaceArea(q) * (0.25 + 0.75 * par);
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

/**
 * Collapses a convex hull to a 4-corner quad by loosening the approxPolyDP
 * epsilon until only 4 vertices remain; a 5-vertex stage is treated as a
 * corner-truncated document and reconstructed geometrically.
 */
function quadFromHull(hull) {
  const peri = cv.arcLength(hull, true);
  for (let f = 0.02; f <= 0.121; f += 0.01) {
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(hull, approx, f * peri, true);
      if (approx.rows === 4) return orderCorners(hullPoints(approx));
      if (approx.rows === 5) {
        const q = pentagonToQuad(hullPoints(approx));
        if (q) return q;
      }
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

/** Shoelace area of an arbitrary point-array polygon. */
function polyAreaPts(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

/** Sutherland–Hodgman clip of polygon `poly` against convex quad `q`.
 *  Inside-sign per edge comes from the quad centroid, so winding order
 *  never matters. Returns the clipped point array (empty if disjoint). */
function clipPolyToQuad(poly, q) {
  const cx = (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4;
  const cy = (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4;
  const edges = [[q.tl, q.tr], [q.tr, q.br], [q.br, q.bl], [q.bl, q.tl]];
  let pts = poly;
  for (const [a, b] of edges) {
    const cross = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const sign = cross({ x: cx, y: cy }) >= 0 ? 1 : -1;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], nxt = pts[(i + 1) % pts.length];
      const cCur = sign * cross(cur), cNxt = sign * cross(nxt);
      if (cCur >= 0) next.push(cur);
      if ((cCur >= 0) !== (cNxt >= 0)) {
        const t = cCur / (cCur - cNxt);
        next.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
      }
    }
    pts = next;
    if (!pts.length) break;
  }
  return pts;
}

/** Fraction of polygon `pts`'s area lying OUTSIDE quad `q` (0..1). */
function fracOutsideQuad(pts, q) {
  const total = polyAreaPts(pts);
  if (total <= 0) return 1;
  const inside = polyAreaPts(clipPolyToQuad(pts, q));
  return Math.min(1, Math.max(0, 1 - inside / total));
}

/** Fraction of polygon `pts`'s area cut off by ONE side of quad `q`. */
function fracCutBySide(pts, q, type) {
  const total = polyAreaPts(pts);
  if (total <= 0) return 0;
  const cx = (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4;
  const cy = (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4;
  const { a, b } = sideOf(q, type);
  const cross = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const sign = cross({ x: cx, y: cy }) >= 0 ? 1 : -1;
  const kept = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], nxt = pts[(i + 1) % pts.length];
    const cCur = sign * cross(cur), cNxt = sign * cross(nxt);
    if (cCur >= 0) kept.push(cur);
    if ((cCur >= 0) !== (cNxt >= 0)) {
      const t = cCur / (cCur - cNxt);
      kept.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
    }
  }
  return Math.min(1, Math.max(0, 1 - polyAreaPts(kept) / total));
}

/** True if point `p` is inside convex quad `q` (centroid-sign test). */
function pointInQuad(p, q) {
  const cx = (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4;
  const cy = (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4;
  const edges = [[q.tl, q.tr], [q.tr, q.br], [q.br, q.bl], [q.bl, q.tl]];
  for (const [a, b] of edges) {
    const cross = (px, py) => (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    const sign = cross(cx, cy) >= 0 ? 1 : -1;
    if (sign * cross(p.x, p.y) < 0) return false;
  }
  return true;
}

/**
 * The region the hull-cut net is allowed to protect: `best.hullPts` clipped
 * down to the DOCUMENT part when other evidence isolates it from a merged
 * neighbor. Without such evidence returns the hull unchanged (identity), so
 * the net keeps its calibrated behavior. Clippers must contain the fused
 * quad's center (rejecting the neighbor lobe) and either be a
 * protrusion-verified split part of best's own blob (tier 1) or a
 * cross-mask-corroborated contributor quad (tier 2).
 */
function consensusHull(best, corners, candidates, contributors, w, h, info) {
  if (!best.hullPts || best.hullPts.length < 3) return best.hullPts;
  const center = {
    x: (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4,
    y: (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) / 4,
  };
  const bestBox = bboxOf(best.corners);
  const clippers = [];
  // Tier 1: protrusion-verified doc part of best's own blob.
  for (const c of candidates) {
    if (c.safe && !c.rejected && c !== best && c.corners &&
        c.score >= 0.3 * best.score &&
        c.parentBBox && bboxIoU(c.parentBBox, bestBox) >= 0.6 &&
        pointInQuad(center, c.corners)) {
      clippers.push({ q: c.corners, tier: 1, mask: c.mask });
    }
  }
  // Tier 2: a contributor quad corroborated by a different-mask twin. A lone
  // interior fragment (e.g. a below-table-line quad) can pass the center and
  // area tests by happenstance; requiring a cross-mask twin blocks it.
  const pool = (contributors || []).filter((c) => c !== best && !c.split &&
    c.corners && c.quadArea >= 0.7 * best.quadArea && pointInQuad(center, c.corners));
  for (const c of pool) {
    const twin = pool.some((d) => d !== c && d.mask !== c.mask &&
      bboxIoU(bboxOf(d.corners), bboxOf(c.corners)) >= 0.8);
    if (twin) clippers.push({ q: c.corners, tier: 2, mask: c.mask });
  }
  let pts = best.hullPts;
  const origArea = polyAreaPts(pts);
  const used = [];
  for (const cl of clippers) {
    const next = clipPolyToQuad(pts, cl.q);
    if (next.length < 3) continue;
    const a = polyAreaPts(next);
    if (a < 0.55 * polyAreaPts(pts)) continue; // one clipper removing >45%
    pts = next;
    used.push(cl.tier + ":" + cl.mask);
  }
  if (polyAreaPts(pts) < 0.45 * origArea) return best.hullPts; // global floor
  if (info) { info.keptFrac = origArea > 0 ? +(polyAreaPts(pts) / origArea).toFixed(3) : 1;
    info.clippers = used; }
  return pts;
}

/** Pushes ONE side of `q` outward until it clears every point in `pts`. */
function coverSide(q, pts, type, w, h) {
  const lines = [];
  for (let t = 0; t < 4; t++) {
    const s = sideOf(q, t);
    if (t !== type) {
      lines.push(lineThrough(s.a, s.b));
      continue;
    }
    const { nx, ny } = outwardNormal(q, s);
    let over = 0;
    for (const p of pts) {
      const d = nx * (p.x - s.a.x) + ny * (p.y - s.a.y);
      if (d > over) over = d;
    }
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
    lines.push({
      px: s.a.x + nx * over, py: s.a.y + ny * over,
      dx: (s.b.x - s.a.x) / len, dy: (s.b.y - s.a.y) / len,
    });
  }
  return validQuadOrNull([
    lineIntersect(lines[3], lines[0]),
    lineIntersect(lines[0], lines[1]),
    lineIntersect(lines[1], lines[2]),
    lineIntersect(lines[2], lines[3]),
  ], w, h) || q;
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
  // Median of SIGNED differences: a real edge is a consistent one-direction
  // step; printed lines surrounded by text produce noisy both-way diffs
  // whose median collapses toward zero.
  const diffs = [];
  for (let t = 0.1; t <= 0.9; t += 0.05) {
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    const x1 = Math.round(px + nx * d), y1 = Math.round(py + ny * d);
    const x2 = Math.round(px - nx * d), y2 = Math.round(py - ny * d);
    if (x1 < 0 || y1 < 0 || x1 >= w || y1 >= h) continue;
    if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
    diffs.push(gray.ucharPtr(y1, x1)[0] - gray.ucharPtr(y2, x2)[0]);
  }
  if (diffs.length < 5) return 0;
  diffs.sort((p, q) => p - q);
  return Math.min(1, Math.abs(diffs[Math.floor(diffs.length / 2)]) / 25);
}

function lineThrough(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { px: a.x, py: a.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
}

/**
 * True if this line's contrast step CONTINUES past both endpoints — a shadow
 * boundary or desk edge crosses the whole scene, while a real paper edge
 * stops at the document corners.
 */
function lineContinuesBeyond(gray, a, b, w, h) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 8) return false;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const nx = -uy, ny = ux;
  const d = Math.max(6, 0.012 * Math.min(w, h));
  const ext = 0.25 * len;
  const diffs = [];
  for (const [ox, oy, dir] of [[a.x, a.y, -1], [b.x, b.y, 1]]) {
    for (let e = 0.3; e <= 1.0; e += 0.175) {
      const px = ox + dir * ux * ext * e, py = oy + dir * uy * ext * e;
      const x1 = Math.round(px + nx * d), y1 = Math.round(py + ny * d);
      const x2 = Math.round(px - nx * d), y2 = Math.round(py - ny * d);
      if (x1 < 0 || y1 < 0 || x1 >= w || y1 >= h) continue;
      if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
      diffs.push(gray.ucharPtr(y1, x1)[0] - gray.ucharPtr(y2, x2)[0]);
    }
  }
  if (diffs.length < 5) return false;
  diffs.sort((p, q) => p - q);
  return Math.abs(diffs[Math.floor(diffs.length / 2)]) / 25 >= 0.4;
}

/**
 * True if the strip between two competing sides still looks like document.
 * Each band sample is compared to the pixel just INSIDE the inner side at
 * the same position (a local paper reference), so brightness gradients and
 * dark artwork on the paper don't break the comparison.
 */
function bandMatchesInside(gray, inner, outer, centroid, w, h) {
  let ok = 0, n = 0;
  for (let t = 0.15; t <= 0.86; t += 0.1) {
    const ax = inner.a.x + (inner.b.x - inner.a.x) * t;
    const ay = inner.a.y + (inner.b.y - inner.a.y) * t;
    const bx = outer.a.x + (outer.b.x - outer.a.x) * t;
    const by = outer.a.y + (outer.b.y - outer.a.y) * t;
    // Local reference: 12px inward (toward the document centroid) from
    // the inner side.
    const dLen = Math.hypot(centroid.x - ax, centroid.y - ay) || 1;
    const rx = Math.round(ax + (centroid.x - ax) / dLen * 12);
    const ry = Math.round(ay + (centroid.y - ay) / dLen * 12);
    const mx = Math.round((ax + bx) / 2), my = Math.round((ay + by) / 2);
    if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
    if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
    n++;
    if (Math.abs(gray.ucharPtr(my, mx)[0] - gray.ucharPtr(ry, rx)[0]) <= 35) ok++;
  }
  return n >= 4 && ok / n >= 0.6;
}

/**
 * Fuses the four document edges from across candidates: per side, prefer the
 * outermost side that shows real cross-edge contrast; sides without contrast
 * (printed tables, merge overshoot through uniform background) lose.
 */
function fuseQuad(candidates, best, gray, w, h, segments, trace, lockedTypes, meta) {
  const bestBox = bboxOf(best.corners);
  // Split parts (other than a winning one) are excluded: their cut chords
  // are interior lines that would poison the side pools.
  const contributors = candidates.filter((c) => !c.rejected &&
    (c === best || !c.split) &&
    c.score >= 0.25 * best.score && bboxIoU(bboxOf(c.corners), bestBox) >= 0.45);
  if (!contributors.length) return null;
  if (meta) meta.contributors = contributors;

  const centroid = {
    x: (best.corners.tl.x + best.corners.tr.x + best.corners.br.x + best.corners.bl.x) / 4,
    y: (best.corners.tl.y + best.corners.tr.y + best.corners.br.y + best.corners.bl.y) / 4,
  };
  const angDiff = (u, v) => {
    const d = Math.abs(u - v) % Math.PI;
    return Math.min(d, Math.PI - d);
  };
  const dirOf = (s) => Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
  // Median gray of the document's central region (interior estimate).
  const interiorVals = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(centroid.x + dx * 0.04 * w);
      const y = Math.round(centroid.y + dy * 0.04 * h);
      if (x >= 0 && y >= 0 && x < w && y < h) interiorVals.push(gray.ucharPtr(y, x)[0]);
    }
  }
  interiorVals.sort((a, b) => a - b);
  const interiorRef = interiorVals.length
    ? interiorVals[Math.floor(interiorVals.length / 2)] : 128;
  // A real document EDGE separates document-looking (inside) from
  // non-document (outside). Sampled at 3 depths per point so sparse text
  // can't imitate background and background can't imitate paper.
  const boundaryLike = (s) => {
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
    let nx = -(s.b.y - s.a.y) / len, ny = (s.b.x - s.a.x) / len;
    const midx = (s.a.x + s.b.x) / 2, midy = (s.a.y + s.b.y) / 2;
    if (nx * (centroid.x - midx) + ny * (centroid.y - midy) > 0) { nx = -nx; ny = -ny; }
    const majority = (px, py, dirX, dirY, test) => {
      let hit = 0, m = 0;
      for (const d of [12, 22, 32]) {
        const x = Math.round(px + dirX * d), y = Math.round(py + dirY * d);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        m++;
        if (test(gray.ucharPtr(y, x)[0])) hit++;
      }
      return m >= 2 && hit / m > 0.5;
    };
    let good = 0, n = 0;
    for (let t = 0.15; t <= 0.86; t += 0.1) {
      const px = s.a.x + (s.b.x - s.a.x) * t;
      const py = s.a.y + (s.b.y - s.a.y) * t;
      const inDoc = majority(px, py, -nx, -ny, (v) => Math.abs(v - interiorRef) <= 35);
      const outNot = majority(px, py, nx, ny, (v) => Math.abs(v - interiorRef) > 30);
      n++;
      if (inDoc && outNot) good++;
    }
    return n >= 5 && good / n >= 0.55;
  };
  // Walk outward, extending only while the strip between sides still looks
  // like the document. NEVER extend past a side already sitting on a strong
  // real edge — strong edges ARE the document boundary.
  const walkOutward = (pick, list) => {
    for (const next of list) {
      if (next.outward <= pick.outward) continue;
      if (next.outward - pick.outward < 8 ||
          bandMatchesInside(gray, pick.s, next.s, centroid, w, h)) {
        pick = next;
      }
    }
    return pick;
  };
  // Segment side-candidates aligned to a direction, gated by contrast and
  // the continues-beyond veto.
  const segSides = (type, refDir, minContrast) => {
    const out = [];
    for (const seg of segments || []) {
      if (angDiff(dirOf({ a: seg.a, b: seg.b }), refDir) > (25 * Math.PI) / 180) continue;
      const mx = (seg.a.x + seg.b.x) / 2, my = (seg.a.y + seg.b.y) / 2;
      const outward = [-1, 1, 1, -1][type] * (type % 2 === 0 ? my : mx);
      const contrast = sideContrast(gray, seg.a, seg.b, w, h);
      if (contrast < minContrast) continue;
      if (lineContinuesBeyond(gray, seg.a, seg.b, w, h)) continue;
      out.push({ s: seg, contrast, outward, continues: false });
    }
    return out;
  };

  const sidesByType = [];
  const chosen = [];
  for (let type = 0; type < 4; type++) {
    // A locked side (the cut chord of a winning safe split) is the
    // doc/occluder seam — no pool, no outward walk, no Hough extension.
    if (lockedTypes && lockedTypes.has(type)) {
      const s = sideOf(best.corners, type);
      const mid = type % 2 === 0 ? (s.a.y + s.b.y) / 2 : (s.a.x + s.b.x) / 2;
      sidesByType.push([]);
      chosen.push({
        s, contrast: sideContrast(gray, s.a, s.b, w, h),
        outward: [-1, 1, 1, -1][type] * mid, locked: true,
      });
      continue;
    }
    const sides = contributors.map((c) => {
      const s = sideOf(c.corners, type);
      const mid = type % 2 === 0 ? (s.a.y + s.b.y) / 2 : (s.a.x + s.b.x) / 2;
      return {
        s,
        contrast: sideContrast(gray, s.a, s.b, w, h),
        outward: [-1, 1, 1, -1][type] * mid,
        isBest: c === best,
      };
    });
    sidesByType.push(sides);
    // Relative gate: a soft-but-real edge stays in play when nothing
    // stronger exists for this side.
    const topContrast = sides.reduce((m, x) => Math.max(m, x.contrast), 0);
    const gate = Math.max(0.35, Math.min(0.5, 0.6 * topContrast));
    // Shadow boundaries and desk edges continue past the document corners;
    // real paper edges don't. Veto the continuers.
    for (const x of sides) {
      x.continues = x.contrast >= 0.15 &&
        lineContinuesBeyond(gray, x.s.a, x.s.b, w, h);
    }
    const bestEntry = sides.find((x) => x.isBest);
    const tol = Math.max(8, 0.01 * Math.min(w, h));
    const likeBoundary = (x) => {
      if (x.bLike === undefined) x.bLike = boundaryLike(x.s);
      return x.bLike;
    };
    // An interior printed line (banner, table border, handwriting baseline)
    // can pass the contrast gate when the true edge is vetoed as continuing
    // into an ADJACENT PAPER. A side moving INWARD of best's own side must
    // therefore also look like a document boundary — interior lines have
    // paper on both sides and fail.
    let eligible = sides.filter((x) => x.contrast >= gate && !x.continues &&
        (x.outward >= bestEntry.outward - tol || likeBoundary(x)))
      .sort((a, b) => a.outward - b.outward);
    let pick, rule = "strict";
    if (!eligible.length) {
      // Outermost boundary-verified side with real edge evidence: a true
      // edge vetoed only because its step continues into a neighboring
      // object. Veto bypassed — an overshoot shadow line fails the
      // inside-check and stays out.
      const bLike = sides.filter((x) => x.contrast >= 0.35 && likeBoundary(x))
        .sort((a, b) => a.outward - b.outward);
      if (bLike.length) {
        pick = bLike[bLike.length - 1];
        rule = "blike";
      } else if (bestEntry.continues && bestEntry.contrast >= 0.35) {
        // The veto killed a genuinely contrasty best side — best's own
        // boundary is the safest anti-cut default (verbatim: no walk, no
        // Hough extension). Bland-background overshoot has ~0 contrast and
        // routes to the low-contrast branch instead.
        pick = bestEntry;
        rule = "bestfb";
      } else {
        // Low-contrast scene (e.g. white paper on a white floor): start from
        // the strongest side, but still walk outward over sides with at least
        // weak edge evidence — a printed form border must not win outright.
        const nonContinuing = sides.filter((x) => !x.continues);
        const pool = nonContinuing.length ? nonContinuing : sides;
        pick = pool.reduce((a, b) => (b.contrast > a.contrast ? b : a));
        eligible = pool.filter((x) => x.contrast >= 0.15 && x.outward >= pick.outward)
          .sort((a, b) => a.outward - b.outward);
        rule = "lowc";
      }
    }
    if (!pick) pick = eligible[0];
    const walkFrom = pick.outward;
    let houghExt = false;
    if (rule !== "bestfb") {
      pick = walkOutward(pick, eligible);
      // Hough segments as OUTWARD-only extensions: a partially visible edge
      // (behind an occluder) can push a side out, but interior form lines can
      // never pull one in.
      if (segments && segments.length && pick.contrast < 0.6) {
        const extras = segSides(type, dirOf(pick.s), 0.35)
          .filter((x) => x.outward > pick.outward &&
                         x.outward - pick.outward <= 0.2 * Math.min(w, h))
          .sort((a, b) => a.outward - b.outward);
        const before = pick;
        pick = walkOutward(pick, extras);
        houghExt = pick !== before;
      }
    }
    pick.rule = rule;
    pick.bestOutward = bestEntry.outward;
    pick.vetoedBest = !!bestEntry.continues;
    pick.walkFrom = walkFrom;
    pick.houghExt = houghExt;
    chosen.push(pick);
  }

  if (meta) meta.rules = chosen.map((p) => p.locked ? "locked" : p.rule);
  if (trace) {
    for (let type = 0; type < 4; type++) {
      const pick = chosen[type];
      trace.push({
        type, contrast: +pick.contrast.toFixed(2), outward: Math.round(pick.outward),
        locked: !!pick.locked, rule: pick.locked ? "locked" : pick.rule,
        bLike: pick.bLike, vetoedBest: !!pick.vetoedBest,
        bestOutward: pick.bestOutward !== undefined ? Math.round(pick.bestOutward) : undefined,
        walkFrom: pick.walkFrom !== undefined ? Math.round(pick.walkFrom) : undefined,
        houghExt: !!pick.houghExt,
        a: { x: Math.round(pick.s.a.x), y: Math.round(pick.s.a.y) },
        b: { x: Math.round(pick.s.b.x), y: Math.round(pick.s.b.y) },
      });
    }
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

/**
 * Grow-only cover: shifts each side of `q` outward until every point in
 * `pts` is inside. Hull simplification can drop an occluded-corner vertex,
 * leaving a diagonal that slices the paper — covering repairs that so a
 * split part's quad can never cut its own content. Falls back to `q`.
 */
function coverQuad(q, pts, w, h) {
  const lines = [];
  for (let type = 0; type < 4; type++) {
    const s = sideOf(q, type);
    const { nx, ny } = outwardNormal(q, s);
    let over = 0;
    for (const p of pts) {
      const d = nx * (p.x - s.a.x) + ny * (p.y - s.a.y);
      if (d > over) over = d;
    }
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
    lines.push({
      px: s.a.x + nx * over, py: s.a.y + ny * over,
      dx: (s.b.x - s.a.x) / len, dy: (s.b.y - s.a.y) / len,
    });
  }
  return validQuadOrNull([
    lineIntersect(lines[3], lines[0]),
    lineIntersect(lines[0], lines[1]),
    lineIntersect(lines[1], lines[2]),
    lineIntersect(lines[2], lines[3]),
  ], w, h) || q;
}

/** Quad-fits an arbitrary point list (via its convex hull) into `out`. */
function candidateFromPoints(pts, w, h, out, maskName) {
  if (pts.length < 8) return null;
  const flat = [];
  for (const p of pts) { flat.push(p.x, p.y); }
  const mat = cv.matFromArray(pts.length, 1, cv.CV_32SC2, flat);
  const hull = new cv.Mat();
  try {
    cv.convexHull(mat, hull, false, true);
    let q = quadFromHull(hull);
    if (!q) return null;
    q = coverQuad(q, hullPoints(hull), w, h);
    const area = cv.contourArea(mat);
    const m = quadMetrics(q, Math.max(area, cv.contourArea(hull) * 0.8),
      cv.contourArea(hull), w, h);
    // Lightly penalized: a declumped part should win over a genuinely bad
    // merged quad but not over a decent one. Marked `split` so its cut
    // chord never joins side pools.
    const cand = {
      corners: q, score: m.score * 0.85, baseScore: m.score, quadArea: m.quadArea,
      borderCorners: m.borderCorners, rejected: m.score <= 0,
      hullPts: hullPoints(hull), mask: maskName, split: true,
    };
    out.push(cand);
    return cand;
  } finally {
    mat.delete(); hull.delete();
  }
}

/**
 * Declumping: a document merged with an occluding paper produces deep
 * concave notches where the two meet. Cut the contour at the two deepest
 * convexity defects and quad-fit each part — the document-only part
 * becomes a clean candidate with its true edges.
 */
function splitCandidates(contour, w, h, out, maskName, ownScore, solidity, diag, gray) {
  const hullIdx = new cv.Mat();
  const defects = new cv.Mat();
  try {
    cv.convexHull(contour, hullIdx, false, false);
    if (hullIdx.rows < 3) return;
    cv.convexityDefects(contour, hullIdx, defects);
    const deep = [];
    for (let i = 0; i < defects.rows; i++) {
      const far = defects.data32S[i * 4 + 2];
      const depth = defects.data32S[i * 4 + 3] / 256;
      if (depth > 0.08 * Math.min(w, h)) deep.push({ far, depth });
    }
    // Split only a deeply notched blob whose own quad is BAD. Widening this
    // to admit rectangle-ish merges was tried and reverted: a genuine paper
    // FOLD (hard2) makes a deep mid-document crease whose two halves each
    // protrude outside the other's quad, passing the mutual-protrusion
    // safety and cutting the document in half.
    const attempt = solidity < 0.88 && ownScore < 0.55;
    if (diag) {
      diag.push({ mask: maskName, solidity: +solidity.toFixed(3),
        ownScore: +ownScore.toFixed(3), nDeep: deep.length,
        depths: deep.slice(0, 3).map((d) => +(d.depth / Math.min(w, h)).toFixed(3)),
        attempt });
    }
    if (!attempt) return;
    if (!deep.length) return;
    deep.sort((a, b) => b.depth - a.depth);
    const pts = [];
    for (let i = 0; i < contour.rows; i++) {
      pts.push({ x: contour.data32S[i * 2], y: contour.data32S[i * 2 + 1] });
    }
    const cuts = deep.slice(0, 2).map((d) => d.far).sort((a, b) => a - b);
    if (cuts.length === 2 && cuts[1] - cuts[0] > 4) {
      const partA = pts.slice(cuts[0], cuts[1] + 1);
      const partB = pts.slice(cuts[1]).concat(pts.slice(0, cuts[0] + 1));
      // A true two-paper merge splits into two SUBSTANTIAL parts. If one
      // part is a sliver, this is just an irregular outline — splitting it
      // would shave a strip off the document.
      const areaA = polyAreaPts(partA), areaB = polyAreaPts(partB);
      const total = areaA + areaB;
      if (total > 0 && Math.min(areaA, areaB) / total >= 0.15) {
        const candA = candidateFromPoints(partA, w, h, out, maskName + "-split");
        const candB = candidateFromPoints(partB, w, h, out, maskName + "-split");
        // Safe-split test: the parts belong to two SEPARATE objects only if
        // each part's contour lies mostly OUTSIDE the other part's quad. A
        // notch in a single paper fails one direction hard (the big part's
        // hull-derived quad swallows the small lobe), so preferring the
        // split can never cut content there. MUTUAL by design: a one-sided
        // test would mark the small part of any notch "safe".
        if (candA && candB && !candA.rejected && !candB.rejected) {
          const outBgivenA = fracOutsideQuad(partB, candA.corners);
          const outAgivenB = fracOutsideQuad(partA, candB.corners);
          const chordContrast = gray ? sideContrast(gray, pts[cuts[0]], pts[cuts[1]], w, h) : 0;
          // Two safe paths. Strong geometric separation (both parts ≥0.6
          // outside each other): true stacks measure ≥0.64; single-paper
          // notches fail at ≤0.35 (receipt3). OR moderate separation (≥0.5)
          // corroborated by a real EDGE along the cut chord (≥0.3) — an
          // occluding paper on top has a visible seam/shadow there (fail15
          // slip-on-note: 0.56 / 0.52), while a notch or fold is same-paper
          // on both sides with no edge (receipt3 0.04, hard2 ≤0.08).
          const mutual = (outBgivenA >= 0.6 && outAgivenB >= 0.6) ||
            (outBgivenA >= 0.5 && outAgivenB >= 0.5 && chordContrast >= 0.3);
          // Self-containment: a part whose own quad fails to cover its own
          // contour (hull simplification dropped an occluded-corner vertex,
          // leaving a diagonal that slices the paper) must never win — the
          // crop would cut visible content.
          const selfOutA = fracOutsideQuad(partA, candA.corners);
          const selfOutB = fracOutsideQuad(partB, candB.corners);
          let x0 = pts[0].x, y0 = pts[0].y, x1 = x0, y1 = y0;
          for (const p of pts) {
            if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
            if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
          }
          const chord = { a: pts[cuts[0]], b: pts[cuts[1]] };
          const chordMid = { x: (chord.a.x + chord.b.x) / 2, y: (chord.a.y + chord.b.y) / 2 };
          if (diag) {
            diag.push({ split: maskName, mutual: +Math.min(outBgivenA, outAgivenB).toFixed(2),
              selfMax: +Math.max(selfOutA, selfOutB).toFixed(3),
              chordContrast: +chordContrast.toFixed(2),
              safe: mutual && Math.max(selfOutA, selfOutB) <= 0.03 });
          }
          for (const [cand, fracOut, fracIn, selfOut] of [
            [candA, outBgivenA, outAgivenB, selfOutA],
            [candB, outAgivenB, outBgivenA, selfOutB],
          ]) {
            const safe = mutual && selfOut <= 0.03;
            cand.safe = safe;
            cand.protrusionOut = fracOut;
            cand.protrusionIn = fracIn;
            cand.selfOut = selfOut;
            cand.parentBBox = { x0, y0, x1, y1 };
            let bestType = 0, bestD = Infinity;
            for (let t = 0; t < 4; t++) {
              const s = sideOf(cand.corners, t);
              const d = (distToSegLine(chord.a, s.a, s.b) +
                distToSegLine(chord.b, s.a, s.b) +
                distToSegLine(chordMid, s.a, s.b)) / 3;
              if (d < bestD) { bestD = d; bestType = t; }
            }
            cand.cutSides = [bestType];
            if (safe) cand.score = cand.baseScore;
          }
        }
      }
    }
  } catch (e) {
    // convexityDefects can throw on self-intersecting contours — skip.
  } finally {
    hullIdx.delete(); defects.delete();
  }
}

/** Collects scored quad candidates from every sizable outer contour of a mask. */
function candidatesFromMask(bin, w, h, out, maskName, diag, gray) {
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
        const hullArea = cv.contourArea(hull);
        const q = quadFromHull(hull);
        if (q) {
          const m = quadMetrics(q, area, hullArea, w, h);
          out.push({
            corners: q, score: m.score, quadArea: m.quadArea,
            borderCorners: m.borderCorners, rejected: m.score <= 0,
            hullPts: hullPoints(hull), mask: maskName,
          });
        } else {
          out.push({ corners: null, score: 0, rejected: true, mask: maskName,
            noQuad: true, areaFrac: area / (w * h) });
        }
        // Deeply notched blob whose own quad is BAD: probably two merged
        // papers — offer the declumped parts as candidates. The split
        // gate lives inside splitCandidates.
        const ownScore = out.length && out[out.length - 1].mask === maskName
          ? out[out.length - 1].score : 0;
        if (hullArea > 0 && area / hullArea < 0.88 && ownScore < 0.55) {
          splitCandidates(contours.get(i), w, h, out, maskName, ownScore, area / hullArea, diag, gray);
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

/** Outward-pointing unit normal of a quad side (away from the centroid). */
function outwardNormal(q, s) {
  const cx = (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4;
  const cy = (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4;
  const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
  let nx = -(s.b.y - s.a.y) / len, ny = (s.b.x - s.a.x) / len;
  const midx = (s.a.x + s.b.x) / 2, midy = (s.a.y + s.b.y) / 2;
  if (nx * (cx - midx) + ny * (cy - midy) > 0) { nx = -nx; ny = -ny; }
  return { nx, ny };
}

function validQuadOrNull(pts, w, h) {
  if (pts.some((p) => !p || !isFinite(p.x) || !isFinite(p.y))) return null;
  if (pts.some((p) => p.x < -0.15 * w || p.x > 1.15 * w ||
                      p.y < -0.15 * h || p.y > 1.15 * h)) return null;
  const q = orderCorners(pts);
  if (!q) return null;
  const angles = internalAngles(q);
  if (angles.some((a) => a < 30 || a > 150)) return null;
  return q;
}

/**
 * Direct anti-clip pass: for each side, march outward from sample points
 * while the pixels still match the paper just inside the side. If most
 * points consistently find the real edge further out, the side snaps to a
 * line fitted through those stop points. Works from the pixels, so it
 * recovers document strips that every candidate mask missed.
 */
function snapSidesOutward(gray, q, w, h, lockedTypes) {
  const maxMarch = 0.1 * Math.min(w, h);
  const origArea = shoelaceArea(q);
  const lines = [];
  let moved = false;
  for (let type = 0; type < 4; type++) {
    const s = sideOf(q, type);
    // Locked seam side (safe-split cut chord): never march outward across
    // the occluder.
    if (lockedTypes && lockedTypes.has(type)) {
      lines.push(lineThrough(s.a, s.b));
      continue;
    }
    const { nx, ny } = outwardNormal(q, s);
    // A side already sitting on a strong real edge must not move — marching
    // outward from it would climb across a merged occluding paper.
    if (sideContrast(gray, s.a, s.b, w, h) >= 0.55) {
      lines.push(lineThrough(s.a, s.b));
      continue;
    }
    // Robust paper reference: median of the just-inside samples along the
    // whole side, so text or artwork under one sample can't poison it.
    const ts = [];
    for (let t = 0.12; t <= 0.89; t += 0.096) ts.push(t);
    const refs = [];
    for (const t of ts) {
      const rx = Math.round(s.a.x + (s.b.x - s.a.x) * t - nx * 6);
      const ry = Math.round(s.a.y + (s.b.y - s.a.y) * t - ny * 6);
      if (rx >= 0 && ry >= 0 && rx < w && ry < h) refs.push(gray.ucharPtr(ry, rx)[0]);
    }
    if (refs.length < 5) { lines.push(lineThrough(s.a, s.b)); continue; }
    refs.sort((p, q2) => p - q2);
    const ref = refs[Math.floor(refs.length / 2)];

    const stops = [];
    for (const t of ts) {
      const px = s.a.x + (s.b.x - s.a.x) * t;
      const py = s.a.y + (s.b.y - s.a.y) * t;
      let d = 0, edgeFound = false, softStart = -1;
      for (let step = 2; step <= maxMarch; step += 2) {
        const x = Math.round(px + nx * step), y = Math.round(py + ny * step);
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const diff = Math.abs(gray.ucharPtr(y, x)[0] - ref);
        if (diff > 20) {
          // Thin dark run (a printed border line) with paper resuming right
          // behind it is not the document edge — hop over it and continue.
          let resumeAt = 0;
          for (let peek = step + 2; peek <= Math.min(step + 12, maxMarch); peek += 2) {
            const qx = Math.round(px + nx * peek), qy = Math.round(py + ny * peek);
            if (qx < 0 || qy < 0 || qx >= w || qy >= h) break;
            if (Math.abs(gray.ucharPtr(qy, qx)[0] - ref) <= 20) { resumeAt = peek; break; }
          }
          if (resumeAt) { d = resumeAt; step = resumeAt; softStart = -1; continue; }
          edgeFound = true;
          break;
        }
        // Soft sustained step (white paper on near-white background): a
        // small but persistent offset marks the boundary.
        if (diff > 9) {
          if (softStart < 0) softStart = step;
          else if (step - softStart >= 10) { d = softStart - 2; edgeFound = true; break; }
        } else {
          softStart = -1;
          d = step;
        }
      }
      // Marches that never hit an edge are unreliable (probably already on
      // background) — only edge-confirmed stops count.
      if (edgeFound) stops.push({ x: px + nx * Math.max(0, d), y: py + ny * Math.max(0, d), d: Math.max(0, d) });
    }
    if (stops.length < 5) { lines.push(lineThrough(s.a, s.b)); continue; }
    const ds = stops.map((o) => o.d).sort((a, b) => a - b);
    const median = ds[Math.floor(ds.length / 2)];
    if (median <= 3) { lines.push(lineThrough(s.a, s.b)); continue; }
    const usable = stops.filter((o) => Math.abs(o.d - median) <= Math.max(6, 0.5 * median));
    if (usable.length < 5) { lines.push(lineThrough(s.a, s.b)); continue; }
    lines.push(fitLinePts(usable));
    moved = true;
  }
  if (!moved) return q;
  const nq = validQuadOrNull([
    lineIntersect(lines[3], lines[0]),
    lineIntersect(lines[0], lines[1]),
    lineIntersect(lines[1], lines[2]),
    lineIntersect(lines[2], lines[3]),
  ], w, h);
  if (!nq) return q;
  const area = shoelaceArea(nq);
  // Snap may only GROW the quad, and never explosively.
  if (area < origArea || area > 1.2 * origArea || area > 1.03 * w * h) return q;
  return nq;
}

/** Pushes every side outward by `margin` px — hairline errors land on
 *  background instead of clipping document content. */
function expandQuad(q, margin, w, h) {
  const lines = [];
  for (let type = 0; type < 4; type++) {
    const s = sideOf(q, type);
    const { nx, ny } = outwardNormal(q, s);
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
    lines.push({
      px: s.a.x + nx * margin, py: s.a.y + ny * margin,
      dx: (s.b.x - s.a.x) / len, dy: (s.b.y - s.a.y) / len,
    });
  }
  return validQuadOrNull([
    lineIntersect(lines[3], lines[0]),
    lineIntersect(lines[0], lines[1]),
    lineIntersect(lines[1], lines[2]),
    lineIntersect(lines[2], lines[3]),
  ], w, h) || q;
}

/**
 * Finds the document outline. Candidate masks (OTSU both polarities, local
 * adaptive threshold, saturation, dilated Canny at two sensitivities) each
 * yield scored quads from their outer contours; edge fusion assembles the
 * best four sides, an outward snap recovers any clipped strips, and a small
 * margin guarantees hairline errors never cut content.
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
  const splitDiag = debug ? [] : null;
  try {
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    const thresholdMask = (type, name) => {
      cv.threshold(gray, bin, 0, 255, type);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      candidatesFromMask(bin, width, height, candidates, name, splitDiag, gray);
    };
    thresholdMask(cv.THRESH_BINARY + cv.THRESH_OTSU, "otsu");
    thresholdMask(cv.THRESH_BINARY_INV + cv.THRESH_OTSU, "otsu-inv");

    // Local adaptive threshold: survives shadow gradients across the paper.
    const block = Math.max(3, (Math.round(Math.min(width, height) / 6) | 1));
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C,
      cv.THRESH_BINARY, block % 2 ? block : block + 1, -4);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
    candidatesFromMask(bin, width, height, candidates, "adaptive", splitDiag, gray);

    // Saturation mask: paper is colorless even in shadow, wood/desks are
    // saturated — survives brightness gradients that break gray thresholds.
    const rgb = new cv.Mat();
    const hsv = new cv.Mat();
    const chans = new cv.MatVector();
    try {
      cv.cvtColor(img, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, chans);
      const sat = chans.get(1);
      cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
      cv.threshold(sat, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      candidatesFromMask(bin, width, height, candidates, "saturation", splitDiag, gray);
      sat.delete();
    } finally {
      rgb.delete(); hsv.delete(); chans.delete();
    }

    // Edge-based candidates: contrast-independent paper outline. The soft
    // pass catches low-contrast paper edges in shadow.
    const segments = [];
    cv.Canny(gray, bin, 50, 150);
    // Harvest straight segments BEFORE dilation — partial document edges
    // (behind occluders, soft seams) become usable side candidates even
    // when no mask isolates a full quad from them.
    const linesMat = new cv.Mat();
    try {
      cv.HoughLinesP(bin, linesMat, 1, Math.PI / 180, 50,
        0.12 * Math.min(width, height), 10);
      for (let i = 0; i < Math.min(linesMat.rows, 80); i++) {
        segments.push({
          a: { x: linesMat.data32S[i * 4], y: linesMat.data32S[i * 4 + 1] },
          b: { x: linesMat.data32S[i * 4 + 2], y: linesMat.data32S[i * 4 + 3] },
        });
      }
    } finally {
      linesMat.delete();
    }
    cv.dilate(bin, bin, kDilate);
    candidatesFromMask(bin, width, height, candidates, "canny", splitDiag, gray);
    cv.Canny(gray, bin, 25, 80);
    cv.dilate(bin, bin, kDilate);
    candidatesFromMask(bin, width, height, candidates, "canny-soft", splitDiag, gray);

    let best = null;
    for (const c of candidates) {
      if (c.rejected) continue;
      if (!best || c.score > best.score) best = c;
    }
    const trace = debug ? [] : null;
    // Reunite a severed document section: a dark internal band (a coloured
    // receipt header, a fold shadow) can sever the document TOP into its own
    // blob under the morphology, so the cleaner BODY sub-rectangle outscores
    // the whole document. If best sits almost entirely inside a substantially
    // larger, still-plausible candidate, prefer that fuller one — cropping to
    // the body would cut the severed section's content. Split winners are
    // exempt (their tightness is intentional, per the stack fixes).
    let reuniteLock = null;
    if (best && !best.split && best.hullPts) {
      let ext = null;
      for (const c of candidates) {
        if (c === best || c.rejected || c.split || !c.corners) continue;
        if (c.quadArea < best.quadArea * 1.25) continue;
        if (c.score < 0.45) continue;
        if (fracOutsideQuad(best.hullPts, c.corners) > 0.12) continue;
        if (!ext || c.score > ext.score) ext = c;
      }
      if (ext) {
        // Which side(s) ext extends beyond the body. The severing band is a
        // strong interior edge fusion/snap/net would re-select as the
        // boundary, undoing the reunion — those sides get locked to ext.
        const margin = 0.04 * Math.min(width, height);
        const outw = (q, t) => {
          const s = sideOf(q, t);
          const mid = t % 2 === 0 ? (s.a.y + s.b.y) / 2 : (s.a.x + s.b.x) / 2;
          return [-1, 1, 1, -1][t] * mid;
        };
        const lock = new Set();
        for (let t = 0; t < 4; t++) {
          if (outw(ext.corners, t) > outw(best.corners, t) + margin) lock.add(t);
        }
        // A genuine severed section is a single edge or one adjacent corner.
        // Extending an OPPOSITE pair (top+bottom / left+right) is a general
        // enlargement (a looser mask), not a reunion — reject it.
        const opposite = (lock.has(0) && lock.has(2)) || (lock.has(1) && lock.has(3));
        // ext must be a well-formed quad: a corner far off-image means a
        // distorted blob (e.g. a paper fold), not the true document.
        const cs = [ext.corners.tl, ext.corners.tr, ext.corners.br, ext.corners.bl];
        const inBounds = cs.every((p) => p.x >= -0.15 * width && p.x <= 1.15 * width &&
          p.y >= -0.15 * height && p.y <= 1.15 * height);
        if (lock.size && !opposite && inBounds) {
          if (trace) trace.push({ reunite: true, from: best.mask, to: ext.mask, lock: [...lock] });
          best = ext;
          reuniteLock = lock;
        }
      }
    }
    // A rectangle PRINTED ON the document (a table, a stamp box) can outscore
    // the paper itself, and threshold blobs can overshoot into background.
    // Fuse the four edges across candidates by cross-edge contrast; fall back
    // to the raw best quad if fusion fails.
    let corners = null;
    let fusedOk = false;
    // Safe-split override: when the merged best is essentially the union a
    // safe split decomposed (parent-blob bbox ≈ best's bbox), prefer the
    // best safe part — its lobe protrudes outside the kept quad, so cropping
    // to it cuts nothing. Unsafe splits never reach here.
    if (best && !best.split) {
      const bestBox = bboxOf(best.corners);
      const linked = candidates.filter((c) => c.safe && !c.rejected &&
        bboxIoU(c.parentBBox, bestBox) >= 0.6);
      if (linked.length) {
        const cand = linked.reduce((a, b) => (b.score > a.score ? b : a));
        if (cand.score >= 0.5 * best.score) {
          if (trace) {
            trace.push({ safeOverride: true, mask: cand.mask,
              fromScore: +best.score.toFixed(4), toScore: +cand.score.toFixed(4) });
          }
          best = cand;
        }
      }
    }
    if (best) {
      // The cut chord of a winning safe split is the doc/occluder seam:
      // locked against outward fusion walks and snap marches, which would
      // climb across the (often paper-like) occluder.
      let locked = best.split && best.safe && best.cutSides
        ? new Set(best.cutSides) : null;
      if (reuniteLock) locked = new Set([...(locked || []), ...reuniteLock]);
      const fuseMeta = {};
      const fused = fuseQuad(candidates, best, gray, width, height, segments, trace, locked, fuseMeta);
      fusedOk = !!fused;
      corners = fused ||
        refineQuadEdges(best.corners, best.hullPts, width, height);
      corners = snapSidesOutward(gray, corners, width, height, locked);
      // Hull-cut safety net: a final side slicing deep into the best blob's
      // hull is cutting probable content — push it back out to the hull.
      // Threshold calibrated on the full test set: legitimate fusion
      // pull-ins (trimming blob overshoot) measure ≤ 0.072 of hull area;
      // content cuts (interior table line winning a side) measure ≥ 0.104.
      // A false positive only loosens the crop, which is the accepted bias.
      if (fusedOk && best.hullPts && best.hullPts.length >= 3) {
        // The net triggers on a cut of best's HULL (calibrated 0.09) but
        // recovers only to the CONSENSUS region — the doc part when another
        // mask isolates it from a merged neighbor. This tightens the loose
        // merge case (fail3) while still covering true content cuts, and is
        // identity when no evidence isolates the doc (degenerate = today).
        const cinfo = trace ? {} : null;
        const prot = consensusHull(best, corners, candidates, fuseMeta.contributors,
          width, height, cinfo);
        if (trace) trace.push({ consensus: true, keptFrac: cinfo && cinfo.keptFrac,
          clippers: cinfo && cinfo.clippers });
        for (let t = 0; t < 4; t++) {
          if (locked && locked.has(t)) continue;
          const f = fracCutBySide(best.hullPts, corners, t);
          const fCons = fracCutBySide(prot, corners, t);
          if (trace) {
            trace.push({ hullCut: t, frac: +f.toFixed(3), fracCons: +fCons.toFixed(3),
              rule: fuseMeta.rules ? fuseMeta.rules[t] : undefined,
              covered: f > 0.09 });
          }
          if (f > 0.09) {
            corners = coverSide(corners, prot, t, width, height);
          }
        }
      }
      corners = expandQuad(corners, 0.004 * Math.min(width, height), width, height);
    }
    if (debug) {
      return {
        corners,
        fusedOk,
        trace,
        segments,
        splitDiag,
        debug: candidates.map((c) => ({
          mask: c.mask, score: +c.score.toFixed(4), rejected: !!c.rejected,
          noQuad: !!c.noQuad, areaFrac: c.areaFrac,
          split: !!c.split, safe: !!c.safe,
          protrusionOut: c.protrusionOut !== undefined ? +c.protrusionOut.toFixed(3) : undefined,
          protrusionIn: c.protrusionIn !== undefined ? +c.protrusionIn.toFixed(3) : undefined,
          selfOut: c.selfOut !== undefined ? +c.selfOut.toFixed(3) : undefined,
          cutSides: c.cutSides,
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
      self.postMessage({ id, ok: true, corners: res.corners, debug: res.debug,
        fusedOk: res.fusedOk, trace: res.trace, segments: res.segments,
        splitDiag: res.splitDiag });
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
