/* page-number.js — the "Page numbers" setting: a small translucent number in
 * the bottom-right corner of every scan that leaves the app.
 *
 * Stamped on the way out rather than into the saved scan. A page's number is
 * its position in the list, and that changes whenever pages are reordered or
 * one is deleted — baking it in would mean re-rendering the whole document
 * every time either happened. Numbering the copy that is exported keeps the
 * number true to the list on screen, costs nothing while the setting is off,
 * and needs no re-render when it is switched on.
 *
 * Exposes window.PageNumber.
 */
(function () {
  "use strict";

  // Both as a share of the scan's longest side, so the mark reads the same on
  // a compact scan as on a full-resolution one.
  const MARK_SIZE_SHARE = 0.022;
  const MARK_MARGIN_SHARE = 0.022;

  const MARK_MIN_SIZE_PX = 12;
  const MARK_COLOUR = "rgba(51, 51, 51, 0.45)";

  const flag = PersistedFlag.create({
    storageKey: "scannerapp:pageNumbers",
    label: "page-numbers",
    defaultEnabled: false,
  });

  /**
   * The same scans with their page number drawn on, in the order given — the
   * order is the numbering. One at a time on purpose: each page is decoded to
   * a full-resolution canvas, and holding a document's worth of those at once
   * is what exhausts iOS Safari.
   *
   * @param onProgress optional (done, total) — the pass is long enough on a
   *                   large document to be worth reporting
   * @returns Promise<Blob[]>
   */
  async function stampAll(scanBlobs, onProgress) {
    const quality = ScanQuality.currentProfile().quality;
    const stamped = [];
    for (const blob of scanBlobs) {
      stamped.push(await stampOne(blob, stamped.length + 1, quality));
      if (onProgress) onProgress(stamped.length, scanBlobs.length);
    }
    return stamped;
  }

  async function stampOne(blob, pageNumber, quality) {
    // Decoded at its own size: ImageUtils clamps the scale at 1, so a bound of
    // the image's longest side is the image itself, whatever that is.
    const canvas = await ImageUtils.decodeImageToCanvas(blob, Number.MAX_SAFE_INTEGER);
    try {
      draw(canvas, String(pageNumber));
      return await ImageUtils.encodeCanvasToJpeg(canvas, quality);
    } finally {
      ImageUtils.releaseCanvas(canvas);
    }
  }

  function draw(canvas, text) {
    const longestSide = Math.max(canvas.width, canvas.height);
    const size = Math.max(MARK_MIN_SIZE_PX, Math.round(longestSide * MARK_SIZE_SHARE));
    const margin = Math.round(longestSide * MARK_MARGIN_SHARE);
    const context = canvas.getContext("2d");
    context.font = `600 ${size}px sans-serif`;
    context.fillStyle = MARK_COLOUR;
    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.fillText(text, canvas.width - margin, canvas.height - margin);
  }

  window.PageNumber = {
    loadPersistedSetting: flag.load,
    isEnabled: flag.isEnabled,
    setEnabled: flag.setEnabled,
    stampAll,
  };
})();
