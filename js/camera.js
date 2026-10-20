/* camera.js — the capture path: acquiring the rear-facing media stream on the
 * lens asked for, playing it inline, turning a tap into the stored JPEG, and
 * releasing the device. It owns no photo storage and no UI beyond the <video> it is handed.
 *
 * Exposes window.CameraStream. `create()` is a factory: each capture session
 * gets its own controller, so no stream is held in module-level state.
 */
(function () {
  "use strict";

  // How large a frame to ask for, how much of it to keep and at what quality
  // all come from CaptureQuality — this module drives the device, not policy.
  // Frames are reduced to the stored size at grab time rather than at export
  // time: a long session holds every shot in memory, and full-resolution
  // iPhone frames exhaust it fast.
  //
  // With no `deviceId` the browser picks the rear camera, and on a phone with
  // several lenses it may hand over a fused camera that switches lens on its
  // own. A lens pinned by `deviceId` is the one lens, for the whole session.
  function mediaConstraints(deviceId) {
    return {
      video: Object.assign(
        deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" },
        CaptureQuality.currentProfile().video),
      audio: false,
    };
  }

  // A stream can open and then never deliver a frame. Without a deadline the
  // shutter stays disabled and the camera light stays on, with no error shown.
  const FIRST_FRAME_TIMEOUT_MS = 10000;

  // How many successive frames a tap compares, keeping the sharpest. The
  // first is grabbed as soon as the lens has been told to focus, which is
  // when the press jolts the phone; seven span six frame intervals past it — 100ms at 60fps, 200ms
  // at 30fps — long enough for the hand to settle and for a lens to finish
  // focusing, too short for the scene to change.
  const FRAMES_PER_SHOT = 7;

  // The share of the frame scored for sharpness when the outline has nothing
  // to offer: the middle, which is where a document being framed is.
  const CENTRAL_REGION_SHARE = 0.6;

  // How long a stream that has reported its size is given to show a first
  // picture. It carries on at the deadline: the grab refuses an empty video
  // itself, so this only keeps the shutter from waiting on a slow camera.
  const FIRST_PICTURE_TIMEOUT_MS = 3000;

  // The longest a shot waits for the video's next frame. A frame arrives far
  // sooner from a running camera; the deadline is for a tab sent to the
  // background mid-shot, whose frame callbacks stop until it returns.
  const FRAME_WAIT_MAX_MS = 100;

  // How long a lens is given to settle after a focus request. The API reports
  // no completion, so this is the budget a shot waits, not a measurement.
  const FOCUS_SETTLE_MS = 300;

  // What a frame is worth here: the pixels an A4 page (long side over short,
  // √2) gets when it fills the frame, once the frame is capped at the kept
  // size.
  const PAGE_ASPECT = Math.SQRT2;

  // How long a stream asked for another frame size is given to deliver one.
  // A browser that keeps the size it had never says so; this is when the
  // session stops waiting and carries on with it.
  const RESIZE_TIMEOUT_MS = 2000;

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

  function pagePixels(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const long = Math.max(width, height) * scale, short = Math.min(width, height) * scale;
    const pageShort = Math.min(short, long / PAGE_ASPECT);
    return pageShort * pageShort * PAGE_ASPECT;
  }

  /** Whether `settings` describe a `width` x `height` frame, either way up —
   *  a phone may report its frame in the sensor's orientation. */
  function isSameSize(settings, width, height) {
    return Math.max(settings.width, settings.height) === Math.max(width, height) &&
      Math.min(settings.width, settings.height) === Math.min(width, height);
  }

  /** Resolves once the video's frames are no longer `width` x `height`, or
   *  at the deadline. */
  function whenResized(video, width, height) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(deadline); video.removeEventListener("resize", onResize); resolve(); };
      const onResize = () => { if (video.videoWidth !== width || video.videoHeight !== height) done(); };
      const deadline = setTimeout(done, RESIZE_TIMEOUT_MS);
      video.addEventListener("resize", onResize);
    });
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

  /** Resolves once the video has presented a picture. Having a size
   *  (whenSized) is not that: metadata arrives before the first decoded
   *  frame, and a grab in between copies nothing — a black photo. */
  function whenPictureShown(video) {
    return new Promise((resolve) => {
      const deadline = setTimeout(done, FIRST_PICTURE_TIMEOUT_MS);
      function done() {
        clearTimeout(deadline);
        video.removeEventListener("loadeddata", done);
        resolve();
      }
      if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(done);
      else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) done();
      else video.addEventListener("loadeddata", done);
    });
  }

  // The resample for the photo that gets kept: area-quality, since the
  // downscale from the native frame is where fine print is won or lost.
  const KEPT_PHOTO_RESAMPLE = { smoothing: "high" };

  /** `view`, fractions of the frame, in the video's own pixels. */
  function viewRect(video, view) {
    const { width, height } = ImageUtils.sourceDimensions(video);
    return { x: view.x * width, y: view.y * height, width: view.width * width, height: view.height * height };
  }

  /** Copies the part of the current video frame `view` shows into a canvas,
   *  capped at the profile's size. Returns null while the stream has no
   *  picture yet — a video that has not decoded a frame draws nothing, and an
   *  empty canvas encodes as black. Synchronous, so a tap captures the frame
   *  the user actually saw. */
  function grabFrame(video, view) {
    const { width, height } = ImageUtils.sourceDimensions(video);
    if (!width || !height || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const { maxEdge } = CaptureQuality.currentProfile();
    return ImageUtils.createScaledCanvas(video, maxEdge,
      { ...KEPT_PHOTO_RESAMPLE, sourceRect: viewRect(video, view) }).canvas;
  }

  /** The middle of what `view` shows. */
  function centralRegion(video, view) {
    const shown = viewRect(video, view);
    const regionWidth = shown.width * CENTRAL_REGION_SHARE, regionHeight = shown.height * CENTRAL_REGION_SHARE;
    return { x: shown.x + (shown.width - regionWidth) / 2, y: shown.y + (shown.height - regionHeight) / 2,
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

  /** Sharpness of the video's current frame over `region`, in video pixels,
   *  and whether that frame is blank. Reads the video rather than a grab of it: the measure only needs 384px
   *  (FrameSharpness scales the region down), so scoring this way costs a
   *  fraction of a full-resolution grab. Safe as long as the caller grabs in
   *  the same task — a video element cannot advance a frame mid-task, and it
   *  is only a later read, after an await, that would see a different one. */
  function assessFrame(video, region) {
    return FrameSharpness.assess(video, region);
  }

  /**
   * The sharpest of the next FRAMES_PER_SHOT frames, or null while the stream
   * has no picture — or only blank ones, as a camera has between lenses.
   * The first is taken synchronously, so a tap still captures what the user
   * saw; the rest follow on the video's own frame callbacks.
   *
   * Every frame is scored, but only one that beats the best so far is grabbed
   * — a grab is a full-resolution draw and a score is a 384px one, so paying
   * for the grab only on a winner is what keeps the preview moving under a
   * burst of taps. The loser it replaces is released at once rather than left
   * to the collector. A blank frame is never a winner, however few frames
   * there are to choose from.
   *
   * @param region  { x, y, width, height } in video pixels to score, or null
   *                for the middle of what `view` shows
   * @param view    the part of the frame to keep, as fractions of it
   */
  async function grabSharpest(video, region, view) {
    // A degenerate box — an outline collapsed to a line — is no region at all.
    const scored = region && region.width >= 1 && region.height >= 1 ? region : centralRegion(video, view);
    let best = null;
    let bestSharpness = -Infinity;
    for (let taken = 0; taken < FRAMES_PER_SHOT; taken++) {
      if (taken > 0) await nextVideoFrame(video);
      const { sharpness, isBlank } = assessFrame(video, scored);
      if (isBlank || sharpness <= bestSharpness) continue; // this frame costs nothing more
      const frame = grabFrame(video, view);
      if (!frame) break; // no picture yet, or the stream ended under us; the best so far stands
      if (best) ImageUtils.releaseCanvas(best);
      best = frame;
      bestSharpness = sharpness;
    }
    return best;
  }

  /** Turns a grabbed frame into the JPEG that gets stored. The frame was
   *  capped at grab time, so it goes straight to the encoder; it stays the
   *  caller's to release. */
  function captureJpeg(frame) {
    return ImageUtils.encodeCanvasToJpeg(frame, CaptureQuality.currentProfile().jpegQuality);
  }

  function create() {
    let stream = null;
    // stop() can run while getUserMedia is still waiting on the permission
    // prompt. The stream that arrives afterwards is held by nothing, so it has
    // to be released on arrival or the camera stays on for the life of the tab.
    let isStopped = false;
    // The cameras each lens is: device ids by lens name, null for a lens
    // this phone does not show the page. Known once the camera is open, since
    // browsers name cameras only after permission is given.
    let lensDevices = { [CaptureLens.ULTRA_WIDE]: null, [CaptureLens.MAIN]: null };
    // How far the frame is cropped in, 1 for the whole of it.
    let zoom = 1;

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

    /** What the camera actually delivers against what was asked —
     *  { width, height, frameRate }, any of them missing where the browser
     *  does not say. The constraints are ideals, so this is the only way to
     *  know whether the frame is the size the profile keeps. */
    function frameSettings() {
      const track = videoTrack();
      return track ? currentSettings(track) : {};
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

    /** The profile asks for a 4:3 frame; a phone that hands one over too
     *  small to beat its 16:9 frame — some offer 4:3 only at a video-call
     *  size — is asked again for the 16:9 frame. Once per start, and nothing
     *  remembered: each session asks the phone afresh. A refusal leaves the
     *  frame it has. */
    function preferLargerPage(video) {
      const track = videoTrack();
      const { maxEdge, fallbackVideo } = CaptureQuality.currentProfile();
      const { videoWidth: width, videoHeight: height } = video;
      const fallbackWorth = pagePixels(fallbackVideo.width.ideal, fallbackVideo.height.ideal, maxEdge);
      if (!track || pagePixels(width, height, maxEdge) >= fallbackWorth) return Promise.resolve();
      // Listening before asking: the first frame of the new size can land
      // before the request is even reported done.
      const resized = whenResized(video, width, height);
      return track.applyConstraints(fallbackVideo)
        .then(() => (isSameSize(currentSettings(track), width, height) ? undefined : resized))
        .catch((error) => console.warn("The camera wouldn't switch to its 16:9 frame:", error));
    }

    /** Switches the camera light. Rejects if the device refuses, so the caller
     *  can put its control back rather than showing a state that isn't real. */
    function setTorch(on) {
      const track = videoTrack();
      if (!track) return Promise.reject(new Error("The camera is not running"));
      return track.applyConstraints({ advanced: [{ torch: on }] });
    }

    /** Whether the phone has an ultra-wide lens the page can pick. */
    function lenses() {
      return { hasUltraWide: lensDevices[CaptureLens.ULTRA_WIDE] !== null };
    }

    /** The part of the frame the photo keeps and the viewfinder shows, as
     *  fractions of it. Re-read at every shot: the zoom can change between. */
    function view() {
      return CaptureLens.viewFor(zoom);
    }

    function setZoom(factor) {
      zoom = factor;
    }

    /** Plays `constraints`' camera in `video`, replacing the one before, and
     *  waits for a first picture. */
    function openStream(video, constraints) {
      return navigator.mediaDevices.getUserMedia(constraints).then((s) => {
        if (isStopped) {
          releaseTracks(s);
          const abandoned = new Error("The camera was released before it opened");
          abandoned.name = "AbortError";
          throw abandoned;
        }
        if (stream) releaseTracks(stream);
        stream = s;
        video.srcObject = s;
        // iOS needs the inline attributes in the markup *and* an explicit
        // play() — autoplay alone is unreliable when the screen re-opens.
        // The autoplay attribute covers the case where this play() is refused,
        // so its rejection is deliberately ignored rather than surfaced.
        PromiseUtils.markRejectionHandled(video.play());
        return whenSized(video)
          .then(() => whenPictureShown(video))
          .then(() => preferLargerPage(video))
          .then(keepFocusing);
      });
    }

    /** Learns which camera is which lens. */
    function discoverLenses() {
      return navigator.mediaDevices.enumerateDevices()
        .then((devices) => {
          lensDevices = {
            [CaptureLens.ULTRA_WIDE]: CaptureLens.pickDevice(devices, CaptureLens.ULTRA_WIDE),
            [CaptureLens.MAIN]: CaptureLens.pickDevice(devices, CaptureLens.MAIN),
          };
        })
        // A phone that will not list its cameras keeps the one it opened.
        .catch((error) => console.warn("Couldn't list the cameras:", error));
    }

    /** Moves to `lens`, a camera of its own: the open one is released first,
     *  since a phone will not run two cameras at once. Resolves at once when
     *  that lens is already running or the phone has no such lens. Rejects if
     *  the lens will not open, leaving nothing running — the caller puts the
     *  old one back or gives up. */
    function selectLens(video, lens) {
      const deviceId = lensDevices[lens];
      const track = videoTrack();
      if (!deviceId || (track && currentSettings(track).deviceId === deviceId)) return Promise.resolve();
      if (stream) releaseTracks(stream);
      stream = null;
      video.srcObject = null;
      return openStream(video, mediaConstraints(deviceId));
    }

    /** Starts the stream on `lens` and plays it in `video`. Must be called
     *  from a user gesture: getUserMedia is invoked before the first await.
     *  Opens the browser's choice of rear camera first, because lens names
     *  arrive only with permission, then moves to the lens asked for. */
    function start(video, lens) {
      if (!isSupported()) return Promise.reject(unsupportedError());
      isStopped = false;
      // A start that fails must not leave the camera running behind the
      // error panel.
      return openStream(video, mediaConstraints(null))
        .then(discoverLenses)
        // A phone without an ultra-wide still gets its main lens pinned.
        .then(() => selectLens(video, lensDevices[lens] ? lens : CaptureLens.MAIN))
        .catch((error) => { stop(video); throw error; });
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

    return { start, stop, supportsTorch, setTorch, focusOn, frameSettings, lenses, selectLens, setZoom, view };
  }

  window.CameraStream = {
    isSupported, describeError, grabSharpest, captureJpeg, create,
  };
})();
