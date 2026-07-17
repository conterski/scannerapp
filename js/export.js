/* export.js — PDF download and "Save to Photos" via the Web Share API.
 * Exposes window.Exporter.
 */
(function () {
  "use strict";

  const JPEG_QUALITY = 0.92;

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function dataURLDims(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error("Bad image"));
      img.src = dataURL;
    });
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /**
   * Builds a PDF from ordered JPEG blobs; each PDF page matches its image's
   * aspect ratio (longest side normalized to A4's 842 pt).
   */
  async function buildPdf(blobs) {
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (const blob of blobs) {
      const dataURL = await blobToDataURL(blob);
      const { w, h } = await dataURLDims(dataURL);
      const scale = 842 / Math.max(w, h);
      const pw = w * scale, ph = h * scale;
      const orientation = ph >= pw ? "p" : "l";
      if (!doc) {
        doc = new jsPDF({ unit: "pt", format: [pw, ph], orientation, compress: true });
      } else {
        doc.addPage([pw, ph], orientation);
      }
      doc.addImage(dataURL, "JPEG", 0, 0, pw, ph);
    }
    return doc.output("blob");
  }

  /** Downloads all pages as a single PDF; offers the share sheet on iOS. */
  async function exportPdf(blobs) {
    const pdfBlob = await buildPdf(blobs);
    const filename = `scan-${timestamp()}.pdf`;
    const file = new File([pdfBlob], filename, { type: "application/pdf" });
    // On iOS the share sheet is far more useful than a Safari download
    // (lets the user pick Files, Mail, print, etc.).
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return { method: "share" };
      } catch (err) {
        if (err.name === "AbortError") return { method: "cancelled" };
        // Fall through to a plain download on any other share failure.
      }
    }
    triggerDownload(pdfBlob, filename);
    return { method: "download" };
  }

  /**
   * Saves ordered page images to the iOS Photos app via the share sheet
   * ("Save Images"). Array order and zero-padded filenames preserve page
   * order. Falls back to sequential downloads when sharing isn't available.
   */
  async function exportPhotos(blobs) {
    const ts = timestamp();
    const files = blobs.map((blob, i) =>
      new File([blob], `scan-${ts}-${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));

    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
        return { method: "share" };
      } catch (err) {
        if (err.name === "AbortError") return { method: "cancelled" };
      }
    }
    // Fallback: ordered individual downloads.
    for (const f of files) {
      triggerDownload(f, f.name);
      await new Promise((r) => setTimeout(r, 350));
    }
    return { method: "download" };
  }

  window.Exporter = { exportPdf, exportPhotos, JPEG_QUALITY };
})();
