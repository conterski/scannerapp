/* mask-candidates.js — candidate quads from regions: a binary mask, its
 * largest outer contours, each contour's convex hull collapsed to four
 * corners. This is the viewfinder outline's path, and the one the user
 * trusts; here it is one source of candidates among others, and the scorer
 * has the last word.
 *
 * The masks at detection are the ones the old detector proved as sources:
 * Otsu on gray (bright paper on a dark desk), its inverse (a dark sheet on
 * a light desk), an adaptive threshold (paper under uneven light), low
 * saturation (paper is colourless while wood and desks are not), dilated
 * Canny edges (an outline that no threshold catches), and colour distance
 * from the desk (a pink copy on brown wood, where gray cannot tell). Each
 * mask quad also comes with a line-snapped variant: a hull that is right on
 * three sides and loose on one gets that side from the line pools without
 * any fusion pass.
 *
 * Worker-global, like every worker module.
 */

const MASKS = Object.freeze({
  morphology: { open: 13, close: 7, dilate: 7 },
  previewMorphology: { open: 7, close: 3, dilate: 3 },
  contoursPerMask: 3,
  minAreaFraction: 0.04,
  backgroundDistance: 20,      // Lab ΔE from the desk's colour that reads as "not desk"
  adaptive: { blockDivisor: 6, constant: -4 },
  snapDistanceOfShortSide: 0.02, // a pool line this close to a hull side replaces it

  // Collapsing a hull to four corners: approxPolyDP with a loosening epsilon;
  // a five-corner stage is a corner-truncated sheet, reconstructed.
  approx: { epsilonStart: 0.02, epsilonLimit: 0.121, epsilonStep: 0.01 },
  pentagon: { minAngleDeg: 35, maxAngleDeg: 145, parallelismToleranceDeg: 30, areaWeight: 0.25, parallelWeight: 0.75 },
});

// ------------------------------------------------------------------
// Hull → quad
// ------------------------------------------------------------------

function hullPoints(hull) {
  const points = [];
  for (let i = 0; i < hull.rows; i++) points.push({ x: hull.data32S[i * 2], y: hull.data32S[i * 2 + 1] });
  return points;
}

function directionOf(from, to) { return Math.atan2(to.y - from.y, to.x - from.x); }

function angleBetweenDirections(first, second) {
  const difference = Math.abs(first - second) % Math.PI;
  return Math.min(difference, Math.PI - difference);
}

/** 1 when both pairs of opposite sides are parallel, falling to 0 at the tolerance. */
function parallelismOf(quad) {
  const skew = angleBetweenDirections(directionOf(quad.tl, quad.tr), directionOf(quad.bl, quad.br)) +
               angleBetweenDirections(directionOf(quad.tl, quad.bl), directionOf(quad.tr, quad.br));
  return Math.max(0, 1 - skew / (MASKS.pentagon.parallelismToleranceDeg * Math.PI / 180));
}

/**
 * A pentagon is usually a document with one corner truncated (occluded by
 * another paper). Reconstruct the quad: drop one side and extend its two
 * neighbours to their intersection. The right drop yields a clean
 * near-parallelogram, so reconstructions are scored by area × parallelism.
 */
function pentagonToQuad(points) {
  const { minAngleDeg, maxAngleDeg, areaWeight, parallelWeight } = MASKS.pentagon;
  let best = null, bestScore = 0;
  for (let dropped = 0; dropped < 5; dropped++) {
    const previousSide = lineThrough(points[(dropped + 4) % 5], points[dropped]);
    const nextSide = lineThrough(points[(dropped + 2) % 5], points[(dropped + 1) % 5]);
    const corner = lineIntersect(previousSide, nextSide);
    if (!corner || !isFinite(corner.x) || !isFinite(corner.y)) continue;
    const quad = orderCorners([corner, points[(dropped + 2) % 5], points[(dropped + 3) % 5], points[(dropped + 4) % 5]]);
    if (!quad) continue;
    if (internalAngles(quad).some((angle) => angle < minAngleDeg || angle > maxAngleDeg)) continue;
    const score = shoelaceArea(quad) * (areaWeight + parallelWeight * parallelismOf(quad));
    if (score > bestScore) { bestScore = score; best = quad; }
  }
  return best;
}

/** Collapses a convex hull to a 4-corner quad, or null when it never gets there. */
function quadFromHull(hull) {
  const { epsilonStart, epsilonLimit, epsilonStep } = MASKS.approx;
  const perimeter = cv.arcLength(hull, true);
  const approx = new cv.Mat();
  try {
    for (let epsilon = epsilonStart; epsilon <= epsilonLimit; epsilon += epsilonStep) {
      cv.approxPolyDP(hull, approx, epsilon * perimeter, true);
      if (approx.rows === 4) return orderCorners(hullPoints(approx));
      if (approx.rows === 5) {
        const quad = pentagonToQuad(hullPoints(approx));
        if (quad) return quad;
      }
    }
    return null;
  } finally {
    approx.delete();
  }
}

// ------------------------------------------------------------------
// Masks → quads
// ------------------------------------------------------------------

/** The quads of a mask's largest outer contours. Cleans the mask in place. */
function quadsFromMask(bin, frame, kernels, source) {
  cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernels.open);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernels.close);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const quads = [];
  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const areas = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      areas.push({ index: i, area: cv.contourArea(contour) });
      contour.delete();
    }
    areas.sort((p, q) => q.area - p.area);
    const minArea = MASKS.minAreaFraction * frame.width * frame.height;
    for (const { index, area } of areas.slice(0, MASKS.contoursPerMask)) {
      if (area < minArea) break;
      const contour = contours.get(index);
      const hull = new cv.Mat();
      try {
        cv.convexHull(contour, hull, false, true);
        const quad = quadFromHull(hull);
        if (quad) quads.push({ quad, source });
      } finally {
        hull.delete();
        contour.delete();
      }
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }
  return quads;
}

function morphologyKernels(sizes) {
  return {
    open: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(sizes.open, sizes.open)),
    close: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(sizes.close, sizes.close)),
    dilate: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(sizes.dilate, sizes.dilate)),
  };
}

/** Paper is colourless even in shadow while wood and desks are saturated. */
function lowSaturationMask(frame, bin) {
  let rgb = null, hsv = null, channels = null, saturation = null;
  try {
    rgb = new cv.Mat();
    hsv = new cv.Mat();
    channels = new cv.MatVector();
    cv.cvtColor(frame.img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    saturation = channels.get(1); // its own wrapper, freed apart from the vector
    cv.GaussianBlur(saturation, saturation, new cv.Size(FRAME.blurKernel, FRAME.blurKernel), 0);
    cv.threshold(saturation, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  } finally {
    releaseMats(saturation, rgb, hsv);
    if (channels) channels.delete();
  }
}

function adaptiveMask(frame, bin) {
  const { blockDivisor, constant } = MASKS.adaptive;
  const block = Math.max(3, Math.round(frame.shortSide / blockDivisor) | 1);
  cv.adaptiveThreshold(frame.grayMat, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, constant);
}

/** Pixels whose colour is not the desk's: a Uint8 mask from the Lab planes. */
function notBackgroundMask(frame) {
  const { l, a, b } = frame.backgroundLab;
  const mask = new Uint8Array(frame.width * frame.height);
  const threshold = MASKS.backgroundDistance * MASKS.backgroundDistance;
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    const dl = frame.lab[p] - l, da = frame.lab[p + 1] - a, db = frame.lab[p + 2] - b;
    if (dl * dl + da * da + db * db > threshold) mask[i] = 255;
  }
  return cv.matFromArray(frame.height, frame.width, cv.CV_8UC1, mask);
}

/**
 * Mask candidates for a frame.
 * @param options { preview } — preview: Otsu, then its inverse only when
 *                 Otsu finds nothing, no colour mask, the lighter morphology
 * @returns [{ quad, source }]
 */
function maskQuads(frame, options) {
  const preview = !!(options && options.preview);
  const kernels = morphologyKernels(preview ? MASKS.previewMorphology : MASKS.morphology);
  const bin = new cv.Mat();
  const quads = [];
  try {
    cv.threshold(frame.grayMat, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    quads.push(...quadsFromMask(bin, frame, kernels, "otsu"));
    if (!preview || !quads.length) {
      cv.threshold(frame.grayMat, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      quads.push(...quadsFromMask(bin, frame, kernels, "otsu-inv"));
    }
    if (!preview) {
      adaptiveMask(frame, bin);
      quads.push(...quadsFromMask(bin, frame, kernels, "adaptive"));
      lowSaturationMask(frame, bin);
      quads.push(...quadsFromMask(bin, frame, kernels, "saturation"));
      if (frame.canny) {
        cv.dilate(frame.canny, bin, kernels.dilate);
        quads.push(...quadsFromMask(bin, frame, kernels, "canny"));
      }
      if (frame.lab) {
        const colour = notBackgroundMask(frame);
        try {
          quads.push(...quadsFromMask(colour, frame, kernels, "colour"));
        } finally {
          colour.delete();
        }
      }
    }
  } finally {
    releaseMats(bin, kernels.open, kernels.close, kernels.dilate);
  }
  return quads;
}

/**
 * A mask quad with each side replaced by the nearest pool line lying within
 * reach of it, when there is one. Null when no side snapped.
 */
function snappedToLines(quad, pools, frame) {
  const reach = MASKS.snapDistanceOfShortSide * frame.shortSide;
  const poolFor = [pools.top, pools.right, pools.bottom, pools.left];
  const lines = [];
  let snapped = 0;
  for (let type = 0; type < SIDE_COUNT; type++) {
    const side = sideOf(quad, type);
    const mid = { x: (side.a.x + side.b.x) / 2, y: (side.a.y + side.b.y) / 2 };
    let best = null, bestDistance = reach;
    for (const line of poolFor[type]) {
      const distance = Math.abs((mid.x - line.line.px) * line.line.dy - (mid.y - line.line.py) * line.line.dx);
      if (distance < bestDistance && angleGapDeg(line.angle, segmentAngleOf(side)) <= LINES.familyBandDeg) {
        best = line; bestDistance = distance;
      }
    }
    if (best) snapped++;
    lines.push(best ? best.line : lineThrough(side.a, side.b));
  }
  if (!snapped) return null;
  return quadFromSideLines(lines, frame);
}
