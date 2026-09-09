/* scan-render.js — the scan render pipeline: one perspective warp, with the
 * quarter rotation folded into the corner mapping so a rotated scan still
 * costs exactly one resample, and then the optional natural-flash look.
 *
 * The warp is geometry only and runs in the worker; the look is a filter and
 * runs on the GPU. Keeping them apart is what lets a scan with the setting off
 * be byte-identical to one from before the filter existed.
 *
 * Exposes window.ScanRenderer.
 */
(function () {
  "use strict";

  const QUARTER_TURNS_PER_REVOLUTION = 4;

  // Which source-quad corner lands at the OUTPUT's tl/tr/br/bl for each
  // clockwise quarter turn. Rotating the labels instead of the pixels makes
  // the warp itself produce the rotated scan — no extra full-res canvas pass.
  const ROTATED_CORNER_LABELS = [
    null,
    { tl: "bl", tr: "tl", br: "tr", bl: "br" }, // 90° CW
    { tl: "br", tr: "bl", br: "tl", bl: "tr" }, // 180°
    { tl: "tr", tr: "br", br: "bl", bl: "tl" }, // 90° CCW
  ];

  function normalizeQuarterTurns(quarterTurns) {
    const turns = quarterTurns % QUARTER_TURNS_PER_REVOLUTION;
    return (turns + QUARTER_TURNS_PER_REVOLUTION) % QUARTER_TURNS_PER_REVOLUTION;
  }

  function rotateCornerLabels(corners, quarterTurns) {
    const labels = ROTATED_CORNER_LABELS[normalizeQuarterTurns(quarterTurns)];
    if (!labels) return corners;
    return {
      tl: corners[labels.tl], tr: corners[labels.tr],
      br: corners[labels.br], bl: corners[labels.bl],
    };
  }

  /**
   * Source canvas plus the page's edits → the final scan canvas.
   * @param options { quarterTurns, maxDim, enhance } — maxDim caps the
   *                output's longest side (Compact mode), omit it for full
   *                size; enhance applies the natural-flash look
   */
  async function renderScan(sourceCanvas, corners, options) {
    const settings = options || {};
    const corrected = rotateCornerLabels(corners, settings.quarterTurns || 0);
    const warpOptions = { maxDim: settings.maxDim };
    if (!settings.enhance) {
      return Detect.warpPerspective(sourceCanvas, corrected, warpOptions);
    }
    // The enhancement takes the warped pixels straight to a texture, so the
    // intermediate canvas the plain path builds is never made.
    const warped = await Detect.warpToImageData(sourceCanvas, corrected, warpOptions);
    return GpuEnhance.apply(warped);
  }

  window.ScanRenderer = { renderScan };
})();
