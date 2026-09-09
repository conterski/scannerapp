/* capture-quality.js — the "High detail" capture mode: how much the camera is
 * asked for, how many of those pixels are kept, and at what JPEG quality.
 *
 * Rapid capture grabs a video frame rather than a still, so the frame is the
 * ceiling on everything downstream — no later processing can recover detail
 * that was never captured. High detail asks the camera for more and keeps
 * more of it, paying for the pixels with a lower JPEG quality.
 *
 * The numbers are measured end to end on the real pipeline, not modelled.
 * High detail keeps 1800x1013 where standard keeps 1600x900 - 27% more pixels
 * for 6% larger exports. Raising the cap further is where the cost turns: the
 * same content at 1900px costs +16% and at 2000px +34%, so 1800 is the last
 * step that stays comfortably inside budget. The quality drop to 0.72 is part
 * of the profile rather than an oversight - it is what pays for the pixels.
 *
 * Exposes window.CaptureQuality.
 */
(function () {
  "use strict";

  // `maxEdge` never upscales — ImageUtils.createScaledCanvas clamps its scale
  // at 1 — so a device that can't deliver these sizes simply keeps what it has.
  const STANDARD_PROFILE = {
    maxEdge: 1600,
    jpegQuality: 0.80,
    video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  };

  // Asks for more than it keeps on purpose: downscaling from a larger frame
  // averages out sensor noise and aliasing, so 1800px taken from a 2560px
  // frame is cleaner than 1800px taken from an 1800px one. 2560x1440 rather
  // than 4K because too high an `ideal` can make Safari choose a
  // low-framerate capture mode, which would spoil the one-tap feel.
  const HIGH_DETAIL_PROFILE = {
    maxEdge: 1800,
    jpegQuality: 0.72,
    video: { width: { ideal: 2560 }, height: { ideal: 1440 } },
  };

  const flag = PersistedFlag.create({
    storageKey: "scannerapp:highDetail",
    label: "high-detail capture",
    defaultEnabled: true,
  });

  function currentProfile() {
    return flag.isEnabled() ? HIGH_DETAIL_PROFILE : STANDARD_PROFILE;
  }

  window.CaptureQuality = {
    loadPersistedSetting: flag.load,
    isEnabled: flag.isEnabled,
    setEnabled: flag.setEnabled,
    currentProfile,
  };
})();
