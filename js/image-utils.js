/* image-utils.js — the canvas work shared by capture, decoding, detection and
 * export: scaling a source into a bounded canvas, decoding a photo with its
 * EXIF orientation applied, and encoding a canvas as JPEG.
 * Exposes window.ImageUtils.
 */
(function () {
  "use strict";

  /** Intrinsic size of anything drawable: <img>, <video>, canvas, ImageBitmap. */
  function sourceDimensions(source) {
    return {
      width: source.naturalWidth || source.videoWidth || source.width || 0,
      height: source.naturalHeight || source.videoHeight || source.height || 0,
    };
  }

  /** Draws `source` into a new canvas whose longest side is at most `maxEdge`.
   *  Returns the applied `scale` so callers can map coordinates back. */
  function createScaledCanvas(source, maxEdge) {
    const { width, height } = sourceDimensions(source);
    const requestedScale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * requestedScale));
    canvas.height = Math.max(1, Math.round(height * requestedScale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return { canvas, scale: canvas.width / width };
  }

  function decodeViaImageElement(blob) {
    return new Promise((resolve, reject) => {
      const objectURL = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(objectURL); resolve(image); };
      image.onerror = () => {
        URL.revokeObjectURL(objectURL);
        reject(new Error("Could not decode image"));
      };
      image.src = objectURL;
    });
  }

  /** createImageBitmap applies EXIF orientation through its option; the <img>
   *  fallback gets the same orientation from the browser for free. */
  function decodeWithExifOrientation(blob) {
    return createImageBitmap(blob, { imageOrientation: "from-image" })
      .catch(() => decodeViaImageElement(blob));
  }

  async function decodeImageToCanvas(blob, maxEdge) {
    const source = await decodeWithExifOrientation(blob);
    const { canvas } = createScaledCanvas(source, maxEdge);
    source.close?.();
    return canvas;
  }

  function encodeCanvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))),
        "image/jpeg", quality);
    });
  }

  window.ImageUtils = {
    sourceDimensions, createScaledCanvas, decodeImageToCanvas, encodeCanvasToJpeg,
  };
})();
