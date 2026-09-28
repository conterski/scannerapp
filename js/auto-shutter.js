/* auto-shutter.js — the shutter that presses itself: once the page has sat
 * steady in the outline, clear of every hint that makes a shot not worth
 * taking, for HOLD_MS, it takes the shot. Then it waits for the page to go
 * — out of view, or moved — before it will fire again, so a page is never
 * taken twice however long it stays; the next page laid down, or the next
 * turned, arms it again.
 *
 * States: "searching" (no page ready), "steadying" (ready, holding), and
 * "waiting" (fired, until the page changes). A tap on the real shutter counts
 * as a shot too, so the auto shutter never takes the page just taken by hand.
 * "Gone" means gone for GONE_MS, not one missed frame: the outline drops out
 * for a moment on a focus sweep or a hand's shadow, and a page that is still
 * there must not be taken again when it comes back.
 *
 * Off by default: a shutter that fires on its own is a change of habit, and
 * the switch is on the capture screen for whoever wants it.
 *
 * Exposes window.AutoShutter.
 */
(function () {
  "use strict";

  // How long a page has to hold ready before the shot: long enough for the
  // outline to have agreed with itself over several frames and for the hand
  // to have stopped, short enough that a stack of pages goes quickly.
  const HOLD_MS = 800;
  // How steadily the outline must hold (CaptureOutline.corners) to count.
  const MIN_STABILITY = 0.75;
  // A corner moving this far — a share of the frame's short side — from where
  // the last shot saw it means another page, or this one moved on purpose.
  const REARM_SHIFT = 0.1;
  // How long no page may be seen before the last one counts as gone. The
  // outline hides after three missed frames (~360 ms); taking a page away and
  // laying the next takes longer than both together.
  const GONE_MS = 600;

  const flag = PersistedFlag.create({
    storageKey: "scannerapp:autoCapture",
    label: "auto-capture",
    defaultEnabled: false,
  });

  /**
   * @param handlers { onFire, onChange } — onFire takes the shot; onChange
   *                 (state) is told each time the state changes
   */
  function create({ onFire, onChange }) {
    let state = "searching";
    let steadySince = 0;
    let lastShot = null;   // the view the last shot was taken of
    let unseenSince = null; // while waiting: when the page was last lost from view

    function become(next) {
      if (next === state) return;
      state = next;
      if (onChange) onChange(state);
    }

    /** Whether the page last shot has been taken away or moved. */
    function hasMovedOn(view, now) {
      if (!view || !view.quad) {
        if (unseenSince === null) unseenSince = now;
        return now - unseenSince >= GONE_MS;
      }
      unseenSince = null;
      const { width, height } = view.frame;
      const limit = REARM_SHIFT * Math.min(width, height);
      return ImageUtils.CORNER_KEYS.some((key) =>
        Math.hypot((view.quad[key].x - lastShot.quad[key].x) * width, (view.quad[key].y - lastShot.quad[key].y) * height) > limit);
    }

    /** A shot was taken of `view` (the outline at the time, or null). */
    function noteShot(view) {
      lastShot = view && view.quad ? view : null;
      unseenSince = null;
      become(lastShot ? "waiting" : "searching");
    }

    /**
     * One frame's reading.
     * @param view  the outline's view of the frame (CaptureGuidance.hintFor)
     * @param hint  the hint for it, whose `blocksAuto` holds the shot back
     * @param now   a timestamp in ms
     */
    function update(view, hint, now) {
      if (state === "waiting") {
        if (!hasMovedOn(view, now)) return;
        become("searching");
      }
      const ready = view && view.quad && view.stability >= MIN_STABILITY && !(hint && hint.blocksAuto);
      if (!ready) { become("searching"); return; }
      if (state !== "steadying") { steadySince = now; become("steadying"); return; }
      if (now - steadySince < HOLD_MS) return;
      noteShot(view);
      onFire();
    }

    /** The frames have stopped, or the switch was touched: a hold under way
     *  is dropped, and the ring with it. The last shot is remembered, so the
     *  page it took is not taken again when the frames come back. */
    function standDown() {
      if (state === "steadying") become("searching");
    }

    return { update, noteShot, standDown };
  }

  window.AutoShutter = {
    HOLD_MS,
    create,
    loadPersistedSetting: flag.load,
    isEnabled: flag.isEnabled,
    setEnabled: flag.setEnabled,
  };
})();
