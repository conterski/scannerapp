/* capture-rotation.js — which way up a shot from the in-page camera is saved.
 *
 * A phone with rotation lock on keeps its interface in portrait however it is
 * held, and getUserMedia hands the page frames in that interface orientation:
 * hold the phone sideways and the frame really is a portrait one with the
 * document lying on its side. The viewfinder still looks right, because the
 * phone and the eye are turned together, but the pixels are not — and the
 * browser has nothing to report either, since screen.orientation.angle stays
 * at 0. So the camera screen asks instead: one button, set once, remembered.
 *
 * The turns are carried by the page rather than burnt into the photo. A
 * page's quarterTurns is folded into the warp's corner mapping (scan-render),
 * so an upright scan costs exactly what a sideways one did — and the editor
 * can still turn it further.
 *
 * Exposes window.CaptureRotation.
 */
(function () {
  "use strict";

  const setting = PersistedFlag.createNumber({
    storageKey: "scannerapp:captureTurns",
    label: "capture rotation",
    defaultValue: 0,
  });

  const DESCRIPTIONS = [
    "Photos saved as the camera sees them",
    "Photos saved rotated 90°",
    "Photos saved rotated 180°",
    "Photos saved rotated 270°",
  ];

  /** 0–3 clockwise quarter turns, whatever was stored. */
  function quarterTurns() {
    return ScanRenderer.normalizeQuarterTurns(setting.get());
  }

  /** The next quarter turn round, saved. */
  function cycle() {
    setting.set(ScanRenderer.normalizeQuarterTurns(quarterTurns() + 1));
  }

  /** What the button should say it is doing. */
  function describe() {
    return DESCRIPTIONS[quarterTurns()];
  }

  window.CaptureRotation = {
    loadPersistedSetting: setting.load,
    quarterTurns,
    cycle,
    describe,
  };
})();
