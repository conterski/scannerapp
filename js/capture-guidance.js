/* capture-guidance.js — the one line of advice the capture screen shows over
 * the viewfinder: what, if anything, stands between this frame and a good
 * scan. Read from what the live outline already knows — where the page is,
 * how steadily it holds, how it is lit — so it costs nothing per frame.
 *
 * hintFor(view, torch) is pure: the first rule that applies wins, most
 * damaging first, since only one line is shown. A hint that `blocksAuto`
 * describes a shot not worth taking (part of the page missing, too few of its
 * pixels, detail burnt out), and holds the auto shutter back; the others are
 * worth fixing but leave a usable shot.
 *
 * createPresenter(render) keeps the line from flickering: a hint appears, or
 * goes, only once it has held for SETTLE_MS.
 *
 * Exposes window.CaptureGuidance.
 */
(function () {
  "use strict";

  // A corner this close to the frame's edge (a share of each dimension) is a
  // page running out of the picture.
  const EDGE_MARGIN = 0.01;
  // A page covering less of the frame than this spends too few of the kept
  // pixels on itself.
  const MIN_PAGE_SHARE = 0.2;
  // More of the page than this saturated is glare, or paper burnt out: the
  // print under it is gone for good.
  const MAX_CLIPPED_SHARE = 0.02;
  // Paper this dark on average (0–255) is underexposed: noise and a long
  // shutter follow. Phones lift exposure hard before it gets here.
  const DARK_MEAN = 60;
  // A pair of opposite sides further apart in length than this is a steep
  // angle: the far side of the page gets few pixels.
  const MAX_KEYSTONE = 1.4;
  // The outline's own steadiness (CaptureOutline.corners) below which the
  // phone is plainly moving.
  const MIN_STEADINESS = 0.5;
  const SETTLE_MS = 400;

  const UNIT_FRAME = { width: 1, height: 1 };

  const HINTS = Object.freeze({
    edge: { text: "Move back — the page runs off the edge", blocksAuto: true },
    small: { text: "Move closer", blocksAuto: true },
    glare: { text: "Glare on the page — tilt the phone or move from the light", blocksAuto: true },
    darkWithTorch: { text: "Too dark — turn on the light", blocksAuto: false },
    dark: { text: "Too dark — find more light", blocksAuto: false },
    keystone: { text: "Hold the phone flat over the page", blocksAuto: false },
    unsteady: { text: "Hold still", blocksAuto: false },
  });

  const hint = (id) => ({ id, ...HINTS[id] });

  /** The longer of each pair of opposite sides over the shorter, in pixels. */
  function keystone(quad, frame) {
    const px = ImageUtils.mapCorners(quad, (p) => ({ x: p.x * frame.width, y: p.y * frame.height }));
    const length = (a, b) => Math.hypot(px[a].x - px[b].x, px[a].y - px[b].y);
    const ratio = (p, q) => Math.max(p, q) / Math.max(Math.min(p, q), 1);
    return Math.max(ratio(length("tl", "tr"), length("bl", "br")), ratio(length("tl", "bl"), length("tr", "br")));
  }

  /**
   * @param view   what the outline reads of a frame — { quad (fractions of
   *               the frame), stability, light: { mean, clipped } | null,
   *               frame: { width, height } } — or null with no page in view
   * @param torch  { available, on } — the camera light, which the dark hint
   *               points to when there is one to turn on
   * @returns { id, text, blocksAuto } or null when the frame is good
   */
  function hintFor(view, torch) {
    if (!view || !view.quad) return null;
    const { quad, stability, light, frame } = view;
    if (ImageUtils.touchesFrameEdge(quad, UNIT_FRAME, EDGE_MARGIN)) return hint("edge");
    if (ImageUtils.quadArea(quad) < MIN_PAGE_SHARE) return hint("small");
    if (light && light.clipped > MAX_CLIPPED_SHARE) return hint("glare");
    if (light && light.mean < DARK_MEAN) return hint(torch && torch.available && !torch.on ? "darkWithTorch" : "dark");
    if (keystone(quad, frame) > MAX_KEYSTONE) return hint("keystone");
    if (stability < MIN_STEADINESS) return hint("unsteady");
    return null;
  }

  /** @param render (hint | null) => void — called only when the line changes */
  function createPresenter(render) {
    let shownId = null;
    let candidate = null; // { id, hint, since }

    return {
      /** Offers this frame's hint (or null) at time `now`. */
      update(next, now) {
        const id = next ? next.id : null;
        if (id === shownId) { candidate = null; return; }
        if (!candidate || candidate.id !== id) { candidate = { id, hint: next, since: now }; return; }
        if (now - candidate.since < SETTLE_MS) return;
        shownId = id;
        candidate = null;
        render(next);
      },
      /** Takes the line down at once: the frames it spoke for have stopped. */
      clear() {
        shownId = null;
        candidate = null;
        render(null);
      },
    };
  }

  window.CaptureGuidance = { hintFor, createPresenter };
})();
