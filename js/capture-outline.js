/* capture-outline.js — the live document outline drawn over the viewfinder.
 *
 * While the camera is open, this asks the detector where the page seems to be
 * and draws that quad over the video, so the user can frame the shot before
 * taking it. Nothing here changes a saved page; but the quad on screen at
 * the moment of the tap is what the shot keeps as its crop — it is the one
 * the user judged when pressing.
 *
 * The loop never queues. A tick that finds a request still in flight skips,
 * so a phone that takes longer per frame simply shows fewer frames — there is
 * no backlog to catch up on and no growing pile of frames in memory.
 *
 * A shot reads two things back from it at the tap: `corners()`, the quad
 * itself, which becomes the page's crop, and `region()`, the box it occupies,
 * where the frames a tap compares are judged for sharpness — on the document
 * rather than on the desk around it.
 *
 * Exposes window.CaptureOutline. `create()` is a factory: one instance per
 * capture session, owning its loop and its polygon.
 */
(function () {
  "use strict";

  // How often a frame is offered to the detector. The detector's own time per
  // frame sets the real rate whenever it is slower than this. Was 150ms; the
  // preview's single-mask pass made a frame a quarter cheaper, and that
  // saving is spent here on a steadier outline at the same cost.
  const PREVIEW_INTERVAL_MS = 120;

  // Share of each new position taken per frame. Raw per-frame quads jitter;
  // blending settles the outline without making it lag noticeably.
  const SMOOTHING = 0.5;

  // Consecutive empty frames before the outline is taken down, so one missed
  // frame does not blink it off.
  const MISSES_BEFORE_HIDE = 3;

  const CORNER_KEYS = ["tl", "tr", "br", "bl"];
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** Unlike an HTML element, an <svg> has no `hidden` property — assigning one
   *  just sets a JS expando and the attribute the stylesheet keys on never
   *  moves. So the attribute is toggled directly. */
  function setSvgHidden(svg, hidden) {
    svg.toggleAttribute("hidden", hidden);
  }

  /**
   * Maps a point in the video's own pixels to the overlay's pixels. The video
   * is drawn with `object-fit: cover`: scaled by the larger of the two ratios
   * and centred, so the overflow on one axis is cropped equally at both ends.
   */
  function coverTransform(videoSize, boxSize) {
    const scale = Math.max(boxSize.width / videoSize.width, boxSize.height / videoSize.height);
    return {
      scale,
      offsetX: (boxSize.width - videoSize.width * scale) / 2,
      offsetY: (boxSize.height - videoSize.height * scale) / 2,
    };
  }

  function blendCorners(previous, next) {
    if (!previous) return next;
    const blended = {};
    for (const key of CORNER_KEYS) {
      blended[key] = {
        x: previous[key].x + (next[key].x - previous[key].x) * SMOOTHING,
        y: previous[key].y + (next[key].y - previous[key].y) * SMOOTHING,
      };
    }
    return blended;
  }

  /**
   * @param svg    the overlay <svg>, laid over the video with the same box
   * @param video  the <video> the frames come from
   */
  function create(svg, video) {
    // The svg is shared across capture sessions; this session's polygon is
    // its only child. Appending instead would leave every earlier session's
    // polygon in place, still holding its last points, to reappear together
    // the moment the svg is shown again.
    const polygon = document.createElementNS(SVG_NS, "polygon");
    svg.replaceChildren(polygon);

    let isRunning = false;
    let isInFlight = false;
    let generation = 0;       // bumped on stop, so a late result draws nothing
    let lastTickAt = 0;
    let shown = null;          // the corners currently drawn, in video pixels
    let missedFrames = 0;

    function draw(corners) {
      // The stream can end between a frame being offered and its result
      // arriving — the OS taking the camera back — and a video with no size
      // has nothing to map the corners onto.
      const videoSize = ImageUtils.sourceDimensions(video);
      if (!videoSize.width || !videoSize.height) { hide(); return; }
      // The video's box, not the svg's: they share it (both inset: 0), and a
      // hidden svg measures 0x0, which is exactly the state the first draw
      // starts from.
      const box = { width: video.clientWidth, height: video.clientHeight };
      const { scale, offsetX, offsetY } = coverTransform(videoSize, box);
      svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
      polygon.setAttribute("points", CORNER_KEYS
        .map((key) => `${corners[key].x * scale + offsetX},${corners[key].y * scale + offsetY}`)
        .join(" "));
      setSvgHidden(svg, false);
    }

    function hide() {
      setSvgHidden(svg, true);
      polygon.removeAttribute("points"); // nothing stale to show if the svg is shown again
      shown = null;
      missedFrames = 0;
    }

    function showResult(corners) {
      if (corners) {
        missedFrames = 0;
        shown = blendCorners(shown, corners);
        draw(shown);
        return;
      }
      missedFrames++;
      if (missedFrames >= MISSES_BEFORE_HIDE) hide();
    }

    async function offerFrame() {
      const requestGeneration = generation;
      isInFlight = true;
      try {
        const corners = await Detect.previewCorners(video);
        if (requestGeneration === generation) showResult(corners);
      } catch (error) {
        // A dead worker would otherwise be rebuilt on every tick — an outline
        // is not worth a recompile storm. Stop, say so once, and let the
        // session carry on without it.
        console.warn("Live outline stopped:", error);
        stop();
      } finally {
        isInFlight = false;
      }
    }

    function tick(now) {
      if (!isRunning) return;
      requestAnimationFrame(tick);
      if (isInFlight || now - lastTickAt < PREVIEW_INTERVAL_MS) return;
      lastTickAt = now;
      offerFrame();
    }

    /** Idempotent: a second start while running does nothing. */
    function start() {
      if (isRunning) return;
      isRunning = true;
      lastTickAt = 0;
      requestAnimationFrame(tick);
    }

    /** Stops the loop and clears the outline. Safe to call repeatedly, and
     *  safe with a request in flight — its result is discarded. */
    function stop() {
      isRunning = false;
      generation++;
      hide();
    }

    /** The box around the outline as drawn, in video pixels — where the
     *  document is, for a shot to judge its sharpness on — or null while no
     *  outline is shown. */
    function region() {
      if (!shown) return null;
      const xs = CORNER_KEYS.map((key) => shown[key].x), ys = CORNER_KEYS.map((key) => shown[key].y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }

    /** The outline as drawn, as fractions of the frame ({tl,tr,br,bl} in
     *  0..1), or null while none is shown. Fractions rather than video
     *  pixels: the shot is scaled at grab, capped at encode and decoded again
     *  before these are used, and only a size-free form survives that
     *  unchanged. A fresh object, since `shown` moves every tick. */
    function corners() {
      const { width, height } = ImageUtils.sourceDimensions(video);
      if (!shown || !width || !height) return null;
      const fractions = {};
      for (const key of CORNER_KEYS) fractions[key] = { x: shown[key].x / width, y: shown[key].y / height };
      return fractions;
    }

    return { start, stop, region, corners, isRunning: () => isRunning };
  }

  window.CaptureOutline = { create, coverTransform };
})();
