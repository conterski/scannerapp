/* camera.js — camera control only: acquiring the rear-facing media stream,
 * playing it inline, grabbing downscaled frames, and releasing the device.
 * It owns no photo storage and no UI beyond the <video> it is handed.
 *
 * Exposes window.CameraStream. `create()` is a factory: each capture session
 * gets its own controller, so no stream is held in module-level state.
 */
(function () {
  "use strict";

  // Frames are downscaled at grab time rather than at export time: a long
  // session holds every shot in memory, and full-resolution iPhone frames
  // exhaust it fast.
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.8;

  const CONSTRAINTS = {
    video: {
      facingMode: "environment", // rear camera by default
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  };

  // A stream can open and then never deliver a frame. Without a deadline the
  // shutter stays disabled and the camera light stays on, with no error shown.
  const FIRST_FRAME_TIMEOUT_MS = 10000;

  const MESSAGES = {
    insecure: "The camera needs a secure (HTTPS) connection.",
    unsupported: "This browser can’t open the camera inside the page.",
    NotAllowedError: "Camera access was denied. Allow it in your browser settings, or add photos from the library instead.",
    SecurityError: "Camera access was blocked by the browser.",
    NotFoundError: "No camera was found on this device.",
    OverconstrainedError: "No camera matched the requested settings.",
    NotReadableError: "The camera is already in use by another app.",
    NoFrameError: "The camera opened but never sent a picture. Try again, or add photos from the library instead.",
  };
  const DEFAULT_MESSAGE = "The camera couldn’t be started.";

  function isSecure() { return window.isSecureContext !== false; }

  function isSupported() {
    return isSecure() &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
         window.HTMLCanvasElement && HTMLCanvasElement.prototype.toBlob);
  }

  /** Human-readable reason a start() rejection happened. */
  function describeError(err) {
    if (!isSecure()) return MESSAGES.insecure;
    if (!err) return DEFAULT_MESSAGE;
    if (err.unsupported) return MESSAGES.unsupported;
    return MESSAGES[err.name] || DEFAULT_MESSAGE;
  }

  function unsupportedError() {
    const err = new Error(isSecure() ? MESSAGES.unsupported : MESSAGES.insecure);
    err.unsupported = true;
    return err;
  }

  /** Resolves once the video reports real dimensions — before that,
   *  drawImage would copy an empty frame. */
  function whenSized(video) {
    if (video.videoWidth && video.videoHeight) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stopWaiting = () => {
        clearTimeout(deadline);
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("loadeddata", onReady);
      };
      const onReady = () => { stopWaiting(); resolve(); };
      const deadline = setTimeout(() => {
        stopWaiting();
        const error = new Error("The camera never delivered a frame");
        error.name = "NoFrameError";
        reject(error);
      }, FIRST_FRAME_TIMEOUT_MS);
      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("loadeddata", onReady);
    });
  }

  /** Copies the current video frame into a canvas capped at MAX_EDGE.
   *  Returns null while the stream has no frame yet. Synchronous, so a tap
   *  captures the frame the user actually saw. */
  function grabFrame(video) {
    const { width, height } = ImageUtils.sourceDimensions(video);
    if (!width || !height) return null;
    return ImageUtils.createScaledCanvas(video, MAX_EDGE).canvas;
  }

  function encodeJpeg(canvas) {
    return ImageUtils.encodeCanvasToJpeg(canvas, JPEG_QUALITY);
  }

  function markRejectionHandled(promise) {
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
    return promise;
  }

  function create() {
    let stream = null;

    /** Starts the stream and plays it in `video`. Must be called from a user
     *  gesture: getUserMedia is invoked before the first await. */
    function start(video) {
      if (!isSupported()) return Promise.reject(unsupportedError());
      return navigator.mediaDevices.getUserMedia(CONSTRAINTS).then((s) => {
        stream = s;
        video.srcObject = s;
        // iOS needs the inline attributes in the markup *and* an explicit
        // play() — autoplay alone is unreliable when the screen re-opens.
        // The autoplay attribute covers the case where this play() is refused,
        // so its rejection is deliberately ignored rather than surfaced.
        markRejectionHandled(video.play());
        // A start that fails must not leave the camera running behind the
        // error panel.
        return whenSized(video).catch((error) => { stop(video); throw error; });
      });
    }

    /** Releases the camera. Safe to call when never started. */
    function stop(video) {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      if (video) video.srcObject = null;
    }

    return { start, stop };
  }

  window.CameraStream = {
    MAX_EDGE, JPEG_QUALITY,
    isSupported, describeError, grabFrame, encodeJpeg, create,
  };
})();
