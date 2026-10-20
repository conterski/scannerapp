/* capture-lens.js — which lens the in-page camera is on and how far it is
 * zoomed, in the terms of the phone's own Camera app.
 *
 * One setting carries both: the zoom step, 0.5×, 1×, 2× or 3×. 0.5× is the
 * ultra-wide lens, the one phones use for close-ups ("macro"); every other
 * step is the main lens, zoomed in for 2× and 3×. Nothing here switches
 * lens by itself — the lens is whatever the step says — which is the point:
 * a camera left to choose its own lens swaps it mid-session.
 *
 * Browsers expose each rear lens as a camera of its own, named by label
 * ("Back Ultra Wide Camera"), and iOS Safari has no zoom control to ask, so
 * zoom here is a centred crop of the frame (see viewFor).
 *
 * Exposes window.CaptureLens. The decisions are pure; only the step is
 * remembered, like the other capture settings.
 */
(function () {
  "use strict";

  const STEPS = [0.5, 1, 2, 3];
  const MACRO_STEP = STEPS[0];
  const NORMAL_STEP = STEPS[1];

  const MACRO = "macro";
  const NORMAL = "normal";

  const BACK_CAMERA = /back|rear|environment/i;
  const ULTRA_WIDE = /ultra[\s-]?wide/i;
  // iOS names the lenses it fuses into one switching camera, and the
  // telephoto on its own; none of them is the plain main lens.
  const NOT_THE_MAIN_LENS = /ultra[\s-]?wide|tele|dual|triple/i;
  const MAIN_LENS = /^back camera$/i;

  const setting = PersistedFlag.createNumber({
    storageKey: "scannerapp:captureZoomStep",
    label: "capture zoom",
    defaultValue: STEPS.indexOf(NORMAL_STEP),
  });

  /** The step the camera is on, whatever was stored. */
  function step() {
    return STEPS[setting.get()] || NORMAL_STEP;
  }

  /** Remembers `next`; a value that is not a step leaves the setting alone. */
  function setStep(next) {
    const index = STEPS.indexOf(next);
    if (index >= 0) setting.set(index);
  }

  /** Where the Macro button goes from `zoomStep`: into the ultra-wide, or
   *  back to the main lens at 1×. */
  function macroToggleStep(zoomStep) {
    return lensFor(zoomStep) === MACRO ? NORMAL_STEP : MACRO_STEP;
  }

  function lensFor(zoomStep) {
    return zoomStep < NORMAL_STEP ? MACRO : NORMAL;
  }

  /** The crop-zoom a step asks of its lens: 0.5× and 1× are each lens's own
   *  full view, and the steps above 1× zoom the main lens in. */
  function digitalZoomFor(zoomStep) {
    return Math.max(1, zoomStep);
  }

  /** The part of the frame a zoom shows, centred, as fractions of it —
   *  { x, y, width, height } in 0..1. */
  function viewFor(zoom) {
    const share = 1 / Math.max(1, zoom);
    return { x: (1 - share) / 2, y: (1 - share) / 2, width: share, height: share };
  }

  /** How far in from each edge of the viewfinder's box (`box`, CSS pixels) the
   *  photo's part of the frame lies at `zoom`. The video is shown whole and
   *  letterboxed, so magnifying it about the box's centre shows more of the
   *  frame, top to bottom, than the photo keeps — the rest is hidden, so that
   *  what is on screen is exactly what a shot keeps.
   *  @param frame  { width, height } of the video's own pixels */
  function clipFor(box, frame, zoom) {
    const scale = Math.min(box.width / frame.width, box.height / frame.height);
    const x = (box.width - frame.width * scale / zoom) / 2;
    const y = (box.height - frame.height * scale / zoom) / 2;
    return { top: y, right: x, bottom: y, left: x };
  }

  /** The camera for `lens` among what enumerateDevices() lists, or null when
   *  the phone has none the page can tell apart — a macro button is then
   *  hidden, and the main lens is left to the browser's own choice. */
  function pickDevice(devices, lens) {
    const matches = (pattern, exclude) => devices.find((device) =>
      device.kind === "videoinput" && BACK_CAMERA.test(device.label) &&
      pattern.test(device.label) && !(exclude && exclude.test(device.label)));
    const found = lens === MACRO ? matches(ULTRA_WIDE) : matches(MAIN_LENS, NOT_THE_MAIN_LENS);
    return found ? found.deviceId : null;
  }

  window.CaptureLens = {
    STEPS, MACRO, NORMAL,
    loadPersistedSetting: setting.load,
    step, setStep, macroToggleStep, lensFor, digitalZoomFor, viewFor, clipFor, pickDevice,
  };
})();
