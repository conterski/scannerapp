/* capture-lens.js — which lens the in-page camera is on and how far it is
 * zoomed, in the terms of the phone's own Camera app.
 *
 * Two settings carry both. The zoom step — 0.5×, 1×, 2× or 3× — is the
 * Camera app's row: 0.5× is the ultra-wide lens in full, every other step
 * the main lens, zoomed in for 2× and 3×. Macro is separate: the ultra-wide
 * lens again, for how close it can focus, but cropped to its middle so the
 * viewfinder looks like the standard 1× view and a page is framed as usual.
 * Nothing here switches lens by itself — the lens is whatever these say —
 * which is the point: a camera left to choose its own lens swaps it
 * mid-session.
 *
 * Browsers expose each rear lens as a camera of its own, named by label
 * ("Back Ultra Wide Camera"), and iOS Safari has no zoom control to ask, so
 * every zoom here is a centred crop of the frame (see viewFor).
 *
 * Exposes window.CaptureLens. The decisions are pure; only the step and
 * macro are remembered, like the other capture settings.
 */
(function () {
  "use strict";

  const STEPS = [0.5, 1, 2, 3];
  const WIDE_STEP = STEPS[0];
  const MAIN_STEP = STEPS[1];

  // The lenses a phone offers, as they are named here.
  const ULTRA_WIDE = "ultra-wide";
  const MAIN = "main";

  // How far Macro crops into the ultra-wide: it sees twice as wide as the
  // main lens (0.5× against 1×), so the middle half of it is the main lens's
  // field of view.
  const MACRO_CROP = 1 / WIDE_STEP;

  const BACK_CAMERA = /back|rear|environment/i;
  const ULTRA_WIDE_LABEL = /ultra[\s-]?wide/i;
  // iOS names the lenses it fuses into one switching camera, and the
  // telephoto on its own; none of them is the plain main lens.
  const NOT_THE_MAIN_LENS = /ultra[\s-]?wide|tele|dual|triple/i;
  const MAIN_LABEL = /^back camera$/i;

  const stepSetting = PersistedFlag.createNumber({
    storageKey: "scannerapp:captureZoomStep",
    label: "capture zoom",
    defaultValue: STEPS.indexOf(MAIN_STEP),
  });
  const macroSetting = PersistedFlag.create({
    storageKey: "scannerapp:captureMacro",
    label: "macro lens",
    defaultEnabled: false,
  });

  function loadPersistedSetting() {
    stepSetting.load();
    macroSetting.load();
  }

  /** The step the camera is on, whatever was stored. */
  function step() {
    return STEPS[stepSetting.get()] || MAIN_STEP;
  }

  /** Remembers `next`; a value that is not a step leaves the setting alone. */
  function setStep(next) {
    const index = STEPS.indexOf(next);
    if (index >= 0) stepSetting.set(index);
  }

  function isMacro() { return macroSetting.isEnabled(); }
  function setMacro(on) { macroSetting.setEnabled(on); }

  /** The lens a step asks for on its own. */
  function lensFor(zoomStep) {
    return zoomStep < MAIN_STEP ? ULTRA_WIDE : MAIN;
  }

  /** The lens the camera should be on: Macro is the ultra-wide whatever the
   *  step says. */
  function currentLens() {
    return isMacro() ? ULTRA_WIDE : lensFor(step());
  }

  /** The crop-zoom of a step and macro setting: 0.5× and 1× are each lens's
   *  own full view, 2× and 3× zoom the main lens in, and Macro crops the
   *  ultra-wide to look like 1×. */
  function zoomFor(zoomStep, macro) {
    return macro ? MACRO_CROP : Math.max(1, zoomStep);
  }

  function zoom() {
    return zoomFor(step(), isMacro());
  }

  /** The part of the frame a zoom shows, centred, as fractions of it —
   *  { x, y, width, height } in 0..1. */
  function viewFor(zoomFactor) {
    const share = 1 / Math.max(1, zoomFactor);
    return { x: (1 - share) / 2, y: (1 - share) / 2, width: share, height: share };
  }

  /** How far in from each edge of the viewfinder's box (`box`, CSS pixels) the
   *  photo's part of the frame lies at `zoomFactor`. The video is shown whole
   *  and letterboxed, so magnifying it about the box's centre shows more of
   *  the frame, top to bottom, than the photo keeps — the rest is hidden, so
   *  that what is on screen is exactly what a shot keeps.
   *  @param frame  { width, height } of the video's own pixels */
  function clipFor(box, frame, zoomFactor) {
    const scale = Math.min(box.width / frame.width, box.height / frame.height);
    const x = (box.width - frame.width * scale / zoomFactor) / 2;
    const y = (box.height - frame.height * scale / zoomFactor) / 2;
    return { top: y, right: x, bottom: y, left: x };
  }

  /** The camera for `lens` among what enumerateDevices() lists, or null when
   *  the phone has none the page can tell apart — Macro and 0.5× are then
   *  hidden, and the main lens is left to the browser's own choice. */
  function pickDevice(devices, lens) {
    const matches = (pattern, exclude) => devices.find((device) =>
      device.kind === "videoinput" && BACK_CAMERA.test(device.label) &&
      pattern.test(device.label) && !(exclude && exclude.test(device.label)));
    const found = lens === ULTRA_WIDE ? matches(ULTRA_WIDE_LABEL) : matches(MAIN_LABEL, NOT_THE_MAIN_LENS);
    return found ? found.deviceId : null;
  }

  window.CaptureLens = {
    STEPS, ULTRA_WIDE, MAIN, MACRO_CROP,
    loadPersistedSetting,
    step, setStep, isMacro, setMacro, lensFor, currentLens, zoomFor, zoom, viewFor, clipFor, pickDevice,
  };
})();
