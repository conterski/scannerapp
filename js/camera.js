/* camera.js — the capture path: acquiring the rear-facing media stream,
 * playing it inline, turning a tap into the stored JPEG, and releasing the
 * device. It owns no photo storage and no UI beyond the <video> it is handed.
 *
 * Exposes window.CameraStream. `create()` is a factory: each capture session
 * gets its own controller, so no stream is held in module-level state.
 */
(function () {
  "use strict";

  // How large a frame to ask for, how much of it to keep, at what quality and
  // whether to denoise all come from CaptureQuality — this module drives the
  // device, not policy. Frames are reduced to the stored size as early as the
  // profile allows rather than at export time: a long session holds every shot
  // in memory, and full-resolution iPhone frames exhaust it fast.
  function mediaConstraints() {
    return {
      video: Object.assign(
        { facingMode: "environment" }, // rear camera by default
        CaptureQuality.currentProfile().video),
      audio: false,
    };
  }

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

  /** Copies the current video frame into a canvas. Returns null while the
   *  stream has no frame yet. Synchronous, so a tap captures the frame the
   *  user actually saw.
   *
   *  A profile that denoises keeps the frame at its native size, because the
   *  filter only works on unscaled grain; every other profile is capped here,
   *  keeping its single resample and its smaller footprint in the queue. */
  function grabFrame(video) {
    const { width, height } = ImageUtils.sourceDimensions(video);
    if (!width || !height) return null;
    const { maxEdge, denoise } = CaptureQuality.currentProfile();
    const grabEdge = denoise ? Math.max(width, height) : maxEdge;
    return ImageUtils.createScaledCanvas(video, grabEdge).canvas;
  }

  /** Denoises a frame, falling back to it unchanged if the worker can't. A
   *  failed filter must cost sharpness, never the photo. */
  function reduceNoise(frame) {
    return Detect.denoiseCanvas(frame).catch((error) => {
      console.warn("Noise reduction failed, keeping the frame as captured:", error);
      return frame;
    });
  }

  /** Applies a cap only when there is something to cut. A scale-1 pass through
   *  createScaledCanvas is a full-frame copy for no gain, and a stream smaller
   *  than the cap is the common case on a device that can't reach it. */
  function capLongestSide(canvas, maxEdge) {
    return Math.max(canvas.width, canvas.height) > maxEdge
      ? ImageUtils.createScaledCanvas(canvas, maxEdge).canvas
      : canvas;
  }

  /** Turns a grabbed frame into the JPEG that gets stored: grain removed while
   *  the frame is still full size, then the profile's cap, then the encode.
   *  Without denoising the cap was already applied at grab time, so the frame
   *  goes straight to the encoder. */
  function captureJpeg(frame) {
    const { maxEdge, jpegQuality, denoise } = CaptureQuality.currentProfile();
    const ready = denoise
      ? reduceNoise(frame).then((clean) => capLongestSide(clean, maxEdge))
      : Promise.resolve(frame);
    return ready.then((canvas) => ImageUtils.encodeCanvasToJpeg(canvas, jpegQuality));
  }

  function create() {
    let stream = null;
    // stop() can run while getUserMedia is still waiting on the permission
    // prompt. The stream that arrives afterwards is held by nothing, so it has
    // to be released on arrival or the camera stays on for the life of the tab.
    let isStopped = false;

    function videoTrack() {
      return stream ? stream.getVideoTracks()[0] || null : null;
    }

    /** Whether this device exposes its camera light. iOS Safari's support is
     *  patchy, so it is probed rather than assumed and the control is hidden
     *  when absent. Some browsers throw instead of omitting getCapabilities. */
    function supportsTorch() {
      const track = videoTrack();
      if (!track || typeof track.getCapabilities !== "function") return false;
      try {
        return track.getCapabilities().torch === true;
      } catch (error) {
        return false;
      }
    }

    /** Switches the camera light. Rejects if the device refuses, so the caller
     *  can put its control back rather than showing a state that isn't real. */
    function setTorch(on) {
      const track = videoTrack();
      if (!track) return Promise.reject(new Error("The camera is not running"));
      return track.applyConstraints({ advanced: [{ torch: on }] });
    }

    /** Starts the stream and plays it in `video`. Must be called from a user
     *  gesture: getUserMedia is invoked before the first await. */
    function start(video) {
      if (!isSupported()) return Promise.reject(unsupportedError());
      isStopped = false;
      return navigator.mediaDevices.getUserMedia(mediaConstraints()).then((s) => {
        if (isStopped) {
          releaseTracks(s);
          const abandoned = new Error("The camera was released before it opened");
          abandoned.name = "AbortError";
          throw abandoned;
        }
        stream = s;
        video.srcObject = s;
        // iOS needs the inline attributes in the markup *and* an explicit
        // play() — autoplay alone is unreliable when the screen re-opens.
        // The autoplay attribute covers the case where this play() is refused,
        // so its rejection is deliberately ignored rather than surfaced.
        PromiseUtils.markRejectionHandled(video.play());
        // A start that fails must not leave the camera running behind the
        // error panel.
        return whenSized(video).catch((error) => { stop(video); throw error; });
      });
    }

    function releaseTracks(target) {
      for (const track of target.getTracks()) track.stop();
    }

    /** Releases the camera. Safe to call when never started, and safe to call
     *  while start() is still waiting — see `isStopped`. */
    function stop(video) {
      isStopped = true;
      if (stream) {
        // Put the light out before releasing. Stopping the track should do it
        // on its own, but asking explicitly is what guarantees the LED is
        // never left burning after Done, a fallback or an error.
        if (supportsTorch()) PromiseUtils.markRejectionHandled(setTorch(false));
        releaseTracks(stream);
        stream = null;
      }
      if (video) video.srcObject = null;
    }

    return { start, stop, supportsTorch, setTorch };
  }

  window.CameraStream = {
    isSupported, describeError, grabFrame, captureJpeg, create,
  };
})();
