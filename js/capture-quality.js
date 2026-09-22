/* capture-quality.js — the "High detail" capture mode: how much the camera is
 * asked for, how many of those pixels are kept, and at what JPEG quality.
 *
 * Rapid capture grabs a video frame rather than a still, so the frame is the
 * ceiling on everything downstream — no later processing can recover detail
 * that was never captured. High detail asks the camera for more and keeps
 * more of it.
 *
 * High detail keeps 2850x1603 where standard keeps 2050x1153 — 4.6 MP
 * against 2.4 MP — downscaled from the native frame with the browser's area
 * resample; 2850px is as far as the app decodes (DECODE_MAX_EDGE in app.js),
 * so the two move together. Nothing is filtered on the way: the frame is
 * resampled and encoded, and that is all. Each profile spends a 1.3x byte
 * allowance over the one before it on pixels first and encoder quality
 * second. Measured over twelve sample photos: at a fixed
 * quality, bytes grow as pixels to the power 0.67, so 1.3x the pixels is
 * 1.19x the bytes; each quality step of 0.01 near 0.85–0.90 is 4–7% more.
 * The previous step (2400px at 0.85 to 2500px at 0.89, 1600px at 0.80 to
 * 1800px at 0.82) was measured directly at 1.25x and 1.26x.
 *
 * Exposes window.CaptureQuality.
 */
(function () {
  "use strict";

  // `maxEdge` never upscales — ImageUtils.createScaledCanvas clamps its scale
  // at 1 — so a device that can't deliver these sizes simply keeps what it has.
  const STANDARD_PROFILE = {
    maxEdge: 2050,
    jpegQuality: 0.84,
    video: { width: { ideal: 2560 }, height: { ideal: 1440 } },
  };

  // Asks for more than it keeps on purpose: downscaling from a larger frame
  // averages out sensor noise and aliasing, so 2850px taken from a 4K frame
  // is cleaner than 2850px taken from a 2850px one.
  //
  // `frameRate: 60` is the shutter-speed request: a stream running at 60fps
  // cannot expose a frame for longer than 1/60s, which is what keeps a
  // handheld shot from smearing. It is an `ideal` rather than a `min` so it
  // can never reject the camera outright — the cost of that safety is that the
  // browser balances it against the size ideals rather than obeying a
  // priority, so a camera that offers 4K only below 60fps is handed one or
  // the other by that balance, and one that reaches 60fps only at a lower
  // resolution hands back a smaller frame. That trade is deliberate: a
  // blurred photo can't be recovered, a slightly smaller one still reads.
  // The short exposure means a higher ISO and some sensor grain; that grain
  // is kept as captured, and the downscale from the larger frame averages
  // most of it away.
  const HIGH_DETAIL_PROFILE = {
    maxEdge: 2850,
    jpegQuality: 0.90,
    video: {
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 60 },
    },
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
