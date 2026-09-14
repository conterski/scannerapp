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

  // How many successive frames a tap compares, keeping the sharpest. Five
  // span four frame intervals — under 140ms at 30fps — long enough for a
  // hand's tremor to pass through a still moment and for the lens to settle
  // after a focus request, too short for the scene to change.
  const FRAMES_PER_SHOT = 5;

  // The share of the frame scored for sharpness when the outline has nothing
  // to offer: the middle, which is where a document being framed is.
  const CENTRAL_REGION_SHARE = 0.6;

  // The longest a shot waits for the video's next frame. A frame arrives far
  // sooner from a running camera; the deadline is for a tab sent to the
  // background mid-shot, whose frame callbacks stop until it returns.
  const FRAME_WAIT_MAX_MS = 100;

  // How long a lens is given to settle after a focus request. The API reports
  // no completion, so this is the budget a shot waits, not a measurement.
  const FOCUS_SETTLE_MS = 300;

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

  // The resample for the photo that gets kept: area-quality, since the
  // downscale from the native frame is where fine print is won or lost.
  const KEPT_PHOTO_RESAMPLE = { smoothing: "high" };

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
    return ImageUtils.createScaledCanvas(video, grabEdge, KEPT_PHOTO_RESAMPLE).canvas;
  }

  function centralRegion(video) {
    const { width, height } = ImageUtils.sourceDimensions(video);
    const regionWidth = width * CENTRAL_REGION_SHARE, regionHeight = height * CENTRAL_REGION_SHARE;
    return { x: (width - regionWidth) / 2, y: (height - regionHeight) / 2,
             width: regionWidth, height: regionHeight };
  }

  /** Resolves on the video's next frame — on the next paint where the frame
   *  callback is missing, which delivers a new frame often enough — or at the
   *  deadline, whichever comes first. */
  function nextVideoFrame(video) {
    return new Promise((resolve) => {
      const deadline = setTimeout(resolve, FRAME_WAIT_MAX_MS);
      const onFrame = () => { clearTimeout(deadline); resolve(); };
      if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    });
  }

  /** Sharpness of the grabbed `frame` over `region`, given in video pixels.
   *  Read from the grab, not the video: the video may already be showing the
   *  next frame by the time it is read again. */
  function sharpnessOf(frame, video, region) {
    const scale = frame.width / ImageUtils.sourceDimensions(video).width;
    return FrameSharpness.measure(frame, {
      x: region.x * scale, y: region.y * scale, width: region.width * scale, height: region.height * scale,
    });
  }

  /**
   * The sharpest of the next FRAMES_PER_SHOT frames, as grabFrame returns
   * them, or null while the stream has no frame. The first is taken
   * synchronously, so a tap still captures what the user saw; the rest follow
   * on the video's own frame callbacks. A frame that loses is released at
   * once — each is a full-resolution one.
   * @param region  { x, y, width, height } in video pixels to score, or null
   *                for the middle of the frame
   */
  async function grabSharpest(video, region) {
    let best = grabFrame(video);
    if (!best) return null;
    // A degenerate box — an outline collapsed to a line — is no region at all.
    const scored = region && region.width >= 1 && region.height >= 1 ? region : centralRegion(video);
    let bestSharpness = sharpnessOf(best, video, scored);
    for (let taken = 1; taken < FRAMES_PER_SHOT; taken++) {
      await nextVideoFrame(video);
      const frame = grabFrame(video);
      if (!frame) break; // the stream ended under us; the best so far stands
      const sharpness = sharpnessOf(frame, video, scored);
      if (sharpness > bestSharpness) {
        ImageUtils.releaseCanvas(best);
        best = frame;
        bestSharpness = sharpness;
      } else {
        ImageUtils.releaseCanvas(frame);
      }
    }
    return best;
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
      ? ImageUtils.createScaledCanvas(canvas, maxEdge, KEPT_PHOTO_RESAMPLE).canvas
      : canvas;
  }

  /** Turns a grabbed frame into the JPEG that gets stored: grain removed while
   *  the frame is still full size, then the profile's cap, then the encode.
   *  Without denoising the cap was already applied at grab time, so the frame
   *  goes straight to the encoder. `frame` stays the caller's to release;
   *  the canvases made on the way are released here, each a full-resolution
   *  one. */
  async function captureJpeg(frame) {
    const { maxEdge, jpegQuality, denoise } = CaptureQuality.currentProfile();
    if (!denoise) return ImageUtils.encodeCanvasToJpeg(frame, jpegQuality);
    const clean = await reduceNoise(frame);
    const capped = capLongestSide(clean, maxEdge);
    try {
      return await ImageUtils.encodeCanvasToJpeg(capped, jpegQuality);
    } finally {
      for (const made of new Set([clean, capped])) if (made !== frame) ImageUtils.releaseCanvas(made);
    }
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

    /** What the running track says it can do — {} when it says nothing, as
     *  iOS Safari mostly does. Some browsers throw instead of omitting
     *  getCapabilities, and a probe must never take the session down. */
    function capabilities() {
      const track = videoTrack();
      if (!track || typeof track.getCapabilities !== "function") return {};
      try {
        return track.getCapabilities() || {};
      } catch (error) {
        return {};
      }
    }

    /** Whether this device exposes its camera light. Probed rather than
     *  assumed, and the control is hidden when absent. */
    function supportsTorch() {
      return capabilities().torch === true;
    }

    function currentSettings(track) {
      return typeof track.getSettings === "function" ? track.getSettings() : {};
    }

    /** Applies a track constraint that is a request, not a requirement: a
     *  refusal is logged, never surfaced, since the session goes on the same. */
    function request(track, constraint, what) {
      return track.applyConstraints({ advanced: [constraint] })
        .catch((error) => console.warn(`The camera wouldn't ${what}:`, error));
    }

    /** Once the stream is up: a camera that can keep focus by itself but
     *  is not doing so is asked to. iOS exposes no focus control, and a
     *  camera already in continuous mode is left alone. */
    function keepFocusing() {
      const track = videoTrack();
      const modes = capabilities().focusMode || [];
      if (!track || !modes.includes("continuous") || currentSettings(track).focusMode === "continuous") return;
      PromiseUtils.markRejectionHandled(request(track, { focusMode: "continuous" }, "keep focusing"));
    }

    /** Points the lens at the document ahead of a shot. Where the track
     *  takes a point of interest, autofocus is aimed at the centre of
     *  `region` (video pixels; the frame's centre without one) so it works
     *  on the sheet rather than the desk. A camera that cannot keep focus
     *  by itself is asked to focus once and given its settling time —
     *  forcing a fresh sweep on one that can would only blur the frames it
     *  passes through. Resolves at once when there is no focus control. */
    function focusOn(region) {
      const track = videoTrack();
      if (!track) return Promise.resolve();
      const { focusMode = [], pointsOfInterest } = capabilities();
      let asked = Promise.resolve();
      if (pointsOfInterest) {
        const { width, height } = currentSettings(track);
        const centre = region
          ? { x: (region.x + region.width / 2) / width, y: (region.y + region.height / 2) / height }
          : { x: 0.5, y: 0.5 };
        if (width && height) asked = request(track, { pointsOfInterest: [centre] }, "aim its focus");
      }
      if (!focusMode.includes("single-shot") || currentSettings(track).focusMode === "continuous") return asked;
      return asked
        .then(() => request(track, { focusMode: "single-shot" }, "focus on request"))
        .then(() => PromiseUtils.delay(FOCUS_SETTLE_MS));
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
        return whenSized(video)
          .then(keepFocusing)
          .catch((error) => { stop(video); throw error; });
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

    return { start, stop, supportsTorch, setTorch, focusOn };
  }

  window.CameraStream = {
    isSupported, describeError, grabSharpest, captureJpeg, create,
  };
})();
