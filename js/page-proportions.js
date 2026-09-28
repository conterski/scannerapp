/* page-proportions.js — how wide a page really is for its height, read from
 * the perspective of its four corners, and which paper size that is.
 *
 * A page photographed at an angle is foreshortened: the side further from
 * the lens comes out shorter, and averaging opposite sides — what the warp
 * used to size its output by — keeps some of that squash. Simulated over
 * phone-like poses the average was off by 3.5% at the median and 18% at the
 * 99th percentile; the reading below, 0.26% and 3%.
 *
 * The four corners of a rectangle fix the camera's focal length whenever
 * both pairs of sides converge (Zhang & He, "Whiteboard scanning and image
 * enhancement", 2007), taking the principal point to be the middle of the
 * frame and the pixels to be square — true of any uncropped phone photo.
 * With the focal length the true proportions follow. When a pair of sides is
 * too near parallel to say — the everyday shot, phone tipped towards the
 * page and nothing else — or when the estimate is not one a phone camera
 * could have, a phone's main camera is assumed instead (0.8 of the long
 * edge). The proportions are least sensitive to the focal length exactly
 * when it cannot be read, so the assumption costs little: at worst 8%.
 *
 * Exposes window.PageProportions.
 */
(function () {
  "use strict";

  // A phone's main lens is a 26–28 mm equivalent: 0.75–0.85 of the frame's
  // long edge once the video mode has cropped and stabilised it.
  const DEFAULT_FOCAL_OF_LONG_EDGE = 0.8;
  // Estimates outside this band are not a phone's main camera (a crop or a
  // telephoto shot moved the principal point or the lens): assume instead.
  const MIN_FOCAL_OF_LONG_EDGE = 0.5;
  const MAX_FOCAL_OF_LONG_EDGE = 2;
  // How far both pairs of sides must converge — the depth ratio of the far
  // corner, less one — before the focal length can be read. Below this, a few
  // pixels of corner noise swing the estimate wildly; measured in simulation
  // with ±4 px of noise, 0.01 is where the worst case stops beating the
  // assumption.
  const MIN_CONVERGENCE = 0.01;

  // Paper sizes, width over height upright, and their size in PDF points.
  // The A series shares one proportion, so A5 and A4 are the same shape.
  const PAPER_SIZES = [
    { name: "A4", aspect: 1 / Math.SQRT2, points: { width: 595.28, height: 841.89 } },
    { name: "Letter", aspect: 8.5 / 11, points: { width: 612, height: 792 } },
    { name: "Legal", aspect: 8.5 / 14, points: { width: 612, height: 1008 } },
  ];
  // A page this close to a paper's proportions is taken to be that paper,
  // well beyond the reading's typical error, and far closer than any two
  // sizes in the table are to each other (A4 and Letter differ by 9%).
  const SNAP_TOLERANCE = 0.02;
  // A rendered scan's pixels round its snapped proportions by far less.
  const PAPER_MATCH_TOLERANCE = 0.005;

  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  /**
   * The page's width over its height — width along tl→tr, height along
   * tl→bl — as the corners' perspective says it is, or null where the
   * corners are not a convex quad seen from the front (a crop dragged into a
   * bow tie): the caller then keeps its own measure.
   * @param corners    {tl,tr,br,bl} in the pixels of the frame they lie in
   * @param frameSize  { width, height } of that frame
   */
  function aspectOf(corners, frameSize) {
    const centre = { x: frameSize.width / 2, y: frameSize.height / 2 };
    const homogeneous = (p) => [p.x - centre.x, p.y - centre.y, 1];
    const [m1, m2, m3, m4] = [corners.tl, corners.tr, corners.bl, corners.br].map(homogeneous);
    // The depth of tr (k2) and bl (k3) against tl's, from the corners alone.
    const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
    const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    if (!(k2 > 0 && k3 > 0)) return null;
    // The two sides out of tl, as directions in the camera's frame (up to the
    // focal length, which scales x and y).
    const across = m2.map((v, i) => k2 * v - m1[i]);
    const down = m3.map((v, i) => k3 * v - m1[i]);
    const focal = focalLength(across, down, Math.max(frameSize.width, frameSize.height));
    const lengthSquared = (n) => n[0] * n[0] + n[1] * n[1] + focal * focal * n[2] * n[2];
    const aspect = Math.sqrt(lengthSquared(across) / lengthSquared(down));
    return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
  }

  /** The focal length the corners imply, where they can say, else a phone's. */
  function focalLength(across, down, longEdge) {
    const readable = Math.abs(across[2]) > MIN_CONVERGENCE && Math.abs(down[2]) > MIN_CONVERGENCE;
    if (readable) {
      const estimate = Math.sqrt(-(across[0] * down[0] + across[1] * down[1]) / (across[2] * down[2]));
      if (estimate >= MIN_FOCAL_OF_LONG_EDGE * longEdge && estimate <= MAX_FOCAL_OF_LONG_EDGE * longEdge) return estimate;
    }
    return DEFAULT_FOCAL_OF_LONG_EDGE * longEdge;
  }

  /** The paper, upright or on its side, whose proportions are within
   *  `tolerance` of `aspect` — with that orientation's aspect and size. */
  function matchPaper(aspect, tolerance) {
    for (const paper of PAPER_SIZES) {
      for (const landscape of [false, true]) {
        const paperAspect = landscape ? 1 / paper.aspect : paper.aspect;
        if (Math.abs(aspect / paperAspect - 1) <= tolerance) {
          const { width, height } = paper.points;
          return { name: paper.name, aspect: paperAspect, points: landscape ? { width: height, height: width } : { width, height } };
        }
      }
    }
    return null;
  }

  /** `aspect`, or the paper size it is within SNAP_TOLERANCE of — so every
   *  page of an A4 document comes out exactly A4. */
  function snapToPaper(aspect) {
    const paper = matchPaper(aspect, SNAP_TOLERANCE);
    return paper ? paper.aspect : aspect;
  }

  /** The paper a rendered scan of `width` x `height` pixels was snapped to,
   *  as { name, points: { width, height } }, or null for any other shape. */
  function paperFor(width, height) {
    return matchPaper(width / height, PAPER_MATCH_TOLERANCE);
  }

  window.PageProportions = { aspectOf, snapToPaper, paperFor };
})();
