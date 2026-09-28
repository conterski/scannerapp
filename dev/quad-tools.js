/* quad-tools.js — how a crop is judged against the paper's true corners, and
 * the four-point homography that maps one quad onto another: shared by the
 * detector overlay page and the automated tests so both grade and warp with
 * one definition. Development tooling: the app never loads it.
 *
 * CUT when any side lies inside the truth by more than 2% of the short side
 * (CRITERIA.md rule 1's blank-margin allowance); side distances are signed
 * along the truth's outward normals, in % of the short side (positive =
 * outside, i.e. background kept).
 *
 * Exposes window.QuadTools.
 */
(function () {
  "use strict";

  const { CORNER_KEYS: KEYS, quadArea } = ImageUtils;
  const SIDE_CORNERS = [["tl", "tr"], ["tr", "br"], ["br", "bl"], ["bl", "tl"]]; // by side type
  const CUT_TOLERANCE_PERCENT = 2; // of the short side, inside the truth: rule 1's blank-margin allowance

  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const quadPolygon = (quad) => KEYS.map((k) => quad[k]);

  /** How a crop sits against the truth. */
  function gradeQuad(crop, truth, bounds) {
    const shortSide = Math.min(bounds.width, bounds.height);
    const centre = { x: mean(KEYS.map((k) => truth[k].x)), y: mean(KEYS.map((k) => truth[k].y)) };
    const sides = SIDE_CORNERS.map(([a, b]) => {
      const length = Math.hypot(truth[b].x - truth[a].x, truth[b].y - truth[a].y) || 1;
      let nx = -(truth[b].y - truth[a].y) / length, ny = (truth[b].x - truth[a].x) / length;
      if (nx * (centre.x - truth[a].x) + ny * (centre.y - truth[a].y) > 0) { nx = -nx; ny = -ny; }
      const out = (p) => ((p.x - truth[a].x) * nx + (p.y - truth[a].y) * ny) / shortSide * 100;
      return +((out(crop[a]) + out(crop[b])) / 2).toFixed(2);
    });
    const corners = KEYS.map((k) => Math.hypot(crop[k].x - truth[k].x, crop[k].y - truth[k].y));
    return {
      sides, cut: sides.some((d) => d < -CUT_TOLERANCE_PERCENT),
      sideError: +Math.max(...sides.map(Math.abs)).toFixed(2),
      excess: +mean(sides.map((d) => Math.max(0, d))).toFixed(2),
      cornerError: +(Math.max(...corners) / Math.hypot(bounds.width, bounds.height) * 100).toFixed(2),
      iou: +iou(crop, truth).toFixed(3),
    };
  }

  /** The quad's corners relabelled tl/tr/br/bl by position — a rotated or
   *  mirrored quad carries its labels round with it. */
  function canonical(quad) {
    const points = quadPolygon(quad);
    const by = (score) => points.reduce((best, p) => (score(p) < score(best) ? p : best));
    return { tl: by((p) => p.x + p.y), tr: by((p) => p.y - p.x), br: by((p) => -p.x - p.y), bl: by((p) => p.x - p.y) };
  }

  /** Sutherland–Hodgman clip of convex `subject` by convex `clipper`, in
   *  either winding: "inside" is the side the clipper's own centroid is on. */
  function clipPolygon(subject, clipper) {
    const centroid = { x: clipper.reduce((s, p) => s + p.x, 0) / clipper.length, y: clipper.reduce((s, p) => s + p.y, 0) / clipper.length };
    let output = subject;
    for (let i = 0; i < clipper.length && output.length; i++) {
      const a = clipper[i], b = clipper[(i + 1) % clipper.length];
      const input = output;
      output = [];
      const cross = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const sign = Math.sign(cross(centroid)) || 1;
      const inside = (p) => cross(p) * sign >= 0;
      const meet = (p, q) => {
        const d = (p.x - q.x) * (a.y - b.y) - (p.y - q.y) * (a.x - b.x);
        if (d === 0) return q; // p–q runs along the clip edge (two equal quads): it is all inside
        const t = ((p.x - a.x) * (a.y - b.y) - (p.y - a.y) * (a.x - b.x)) / d;
        return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
      };
      for (let j = 0; j < input.length; j++) {
        const p = input[j], q = input[(j + 1) % input.length];
        if (inside(q)) { if (!inside(p)) output.push(meet(p, q)); output.push(q); }
        else if (inside(p)) output.push(meet(p, q));
      }
    }
    return output;
  }

  function polygonArea(poly) {
    return Math.abs(poly.reduce((sum, p, i) => sum + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2;
  }

  /** Intersection over union of two quads. */
  function iou(a, b) {
    const clipped = clipPolygon(quadPolygon(a), quadPolygon(b));
    const shared = clipped.length ? polygonArea(clipped) : 0;
    const union = quadArea(a) + quadArea(b) - shared;
    return union > 0 ? shared / union : 0;
  }

  /** The projective map taking the four points `from` onto the four points
   *  `to` (arrays in the same order), as a function of a point. */
  function homography(from, to) {
    const rows = [], rhs = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i], { x: u, y: v } = to[i];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
    }
    for (let c = 0; c < 8; c++) { // Gaussian elimination with partial pivoting
      let pivot = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
      [rows[c], rows[pivot]] = [rows[pivot], rows[c]]; [rhs[c], rhs[pivot]] = [rhs[pivot], rhs[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = rows[r][c] / rows[c][c];
        for (let k = c; k < 8; k++) rows[r][k] -= f * rows[c][k];
        rhs[r] -= f * rhs[c];
      }
    }
    const h = rhs.map((value, i) => value / rows[i][i]);
    return (p) => { const w = h[6] * p.x + h[7] * p.y + 1; return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }; };
  }

  /** The largest corner displacement between two quads, as a percentage of `diagonal`. */
  function maxShiftPercent(a, b, diagonal) {
    return Math.max(...KEYS.map((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y))) / diagonal * 100;
  }

  window.QuadTools = {
    SIDE_CORNERS, CUT_TOLERANCE_PERCENT,
    gradeQuad, canonical, clipPolygon, polygonArea, iou, maxShiftPercent, quadPolygon, homography,
  };
})();
