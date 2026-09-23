/* export.js — PDF download and "Save to Photos", both routed through the Web
 * Share API when it is available and through plain downloads when it isn't,
 * plus the text-only share the message boxes use ahead of them.
 * Exposes window.Exporter.
 */
(function () {
  "use strict";

  // Each PDF page matches its image's aspect ratio, with the longest side
  // normalized to A4's long edge in points.
  const A4_LONG_EDGE_PT = 842;

  // Safari drops downloads fired back-to-back, so the fallback paces them.
  const DOWNLOAD_STAGGER_MS = 350;
  const OBJECT_URL_LIFETIME_MS = 30000;

  // Page order has to survive the hand-off: a receiving app may lay the files
  // out by name or by date, and identical timestamps leave it to sort ties
  // however it likes — which is how a three-photo share can arrive shuffled.
  // Numbering every file and dating them a second apart, both ascending, makes
  // every reading of the set agree with the page list on screen.
  const FILENAME_MIN_INDEX_DIGITS = 2;
  const FILENAME_DATE_STEP_MS = 1000;

  // ---------------------------------------------------------------
  // Public exports
  // ---------------------------------------------------------------

  /** Saves all pages as one PDF; offers the share sheet first on iOS. */
  async function exportPdf(scanBlobs) {
    const pdfBlob = await buildPdf(scanBlobs);
    const filename = `scan-${timestamp()}.pdf`;
    const pdfFile = new File([pdfBlob], filename, { type: "application/pdf" });
    return shareOrDownload([pdfFile], () => triggerDownload(pdfBlob, filename));
  }

  /**
   * Saves ordered page images to the iOS Photos app via the share sheet
   * ("Save Images"). Array order and zero-padded filenames preserve page
   * order. Falls back to sequential downloads when sharing isn't available.
   */
  async function exportPhotos(scanBlobs) {
    const imageFiles = toNumberedImageFiles(scanBlobs);
    return shareOrDownload(imageFiles, () => downloadInOrder(imageFiles));
  }

  // ---------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------

  /**
   * On iOS the share sheet is far more useful than a Safari download (it lets
   * the user pick Files, Mail, print). Anything other than the user cancelling
   * falls back to downloading.
   * @returns {method: "share" | "cancelled" | "download"}
   */
  async function shareOrDownload(files, downloadAll) {
    const method = await tryShare({ files });
    if (method !== "unavailable") return { method };
    await downloadAll();
    return { method: "download" };
  }

  /** A message on its own, for the chat it is meant to precede the scans in.
   *  Nothing to fall back to: text that can't be shared stays on screen.
   *  @returns {method: "share" | "cancelled" | "unavailable"} */
  async function shareText(text) {
    return { method: await tryShare({ text }) };
  }

  /** @returns "share" when the user completed the sheet, "cancelled" when they
   *  dismissed it, "unavailable" when sharing this data isn't possible here. */
  async function tryShare(data) {
    if (!(navigator.canShare && navigator.canShare(data))) return "unavailable";
    try {
      await navigator.share(data);
      return "share";
    } catch (error) {
      if (error.name === "AbortError") return "cancelled";
      console.warn("Sharing failed:", error);
      return "unavailable";
    }
  }

  function triggerDownload(blob, filename) {
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectURL;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectURL), OBJECT_URL_LIFETIME_MS);
  }

  async function downloadInOrder(files) {
    for (const file of files) {
      triggerDownload(file, file.name);
      await PromiseUtils.delay(DOWNLOAD_STAGGER_MS);
    }
  }

  function toNumberedImageFiles(scanBlobs) {
    const sessionTimestamp = timestamp();
    // Wide enough for the last page, so page 100 can never sort before 99.
    const digits = Math.max(FILENAME_MIN_INDEX_DIGITS, String(scanBlobs.length).length);
    const firstModified = Date.now();
    return scanBlobs.map((blob, index) => {
      const pageNumber = String(index + 1).padStart(digits, "0");
      return new File([blob], `scan-${sessionTimestamp}-${pageNumber}.jpg`, {
        type: "image/jpeg",
        lastModified: firstModified + index * FILENAME_DATE_STEP_MS,
      });
    });
  }

  // ---------------------------------------------------------------
  // PDF assembly
  // ---------------------------------------------------------------

  async function buildPdf(scanBlobs) {
    const { jsPDF } = window.jspdf;
    let pdf = null;
    for (const blob of scanBlobs) {
      const dataURL = await blobToDataURL(blob);
      const page = await pageSizeFor(dataURL);
      const orientation = page.height >= page.width ? "p" : "l";
      if (pdf) {
        pdf.addPage([page.width, page.height], orientation);
      } else {
        pdf = new jsPDF({
          unit: "pt", format: [page.width, page.height], orientation, compress: true,
        });
      }
      pdf.addImage(dataURL, "JPEG", 0, 0, page.width, page.height);
    }
    return pdf.output("blob");
  }

  async function pageSizeFor(dataURL) {
    const { width, height } = await imageDimensions(dataURL);
    const scale = A4_LONG_EDGE_PT / Math.max(width, height);
    return { width: width * scale, height: height * scale };
  }

  // ---------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function imageDimensions(dataURL) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("Bad image"));
      image.src = dataURL;
    });
  }

  function timestamp() {
    const now = new Date();
    const padTwo = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${padTwo(now.getMonth() + 1)}${padTwo(now.getDate())}` +
      `-${padTwo(now.getHours())}${padTwo(now.getMinutes())}`;
  }

  window.Exporter = { exportPdf, exportPhotos, shareText };
})();
