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
    let lastShot = null; // the view the last shot was taken of

    function become(next) {
      if (next === state) return;
      state = next;
      if (onChange) onChange(state);
    }

    function hasMovedOn(view) {
      if (!view || !view.quad) return true;
      const { width, height } = view.frame;
      const limit = REARM_SHIFT * Math.min(width, height);
      return ImageUtils.CORNER_KEYS.some((key) =>
        Math.hypot((view.quad[key].x - lastShot.quad[key].x) * width, (view.quad[key].y - lastShot.quad[key].y) * height) > limit);
    }

    /** A shot was taken of `view` (the outline at the time, or null). */
    function noteShot(view) {
      lastShot = view && view.quad ? view : null;
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
        if (!hasMovedOn(view)) return;
        become("searching");
      }
      const ready = view && view.quad && view.stability >= MIN_STABILITY && !(hint && hint.blocksAuto);
      if (!ready) { become("searching"); return; }
      if (state !== "steadying") { steadySince = now; become("steadying"); return; }
      if (now - steadySince < HOLD_MS) return;
      noteShot(view);
      onFire();
    }

    /** Back to searching, forgetting the last shot: the frames stopped. */
    function reset() {
      lastShot = null;
      become("searching");
    }

    return { update, noteShot, reset };
  }

  window.AutoShutter = {
    HOLD_MS,
    create,
    loadPersistedSetting: flag.load,
    isEnabled: flag.isEnabled,
    setEnabled: flag.setEnabled,
  };
})();
