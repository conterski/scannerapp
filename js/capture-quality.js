/* capture-quality.js — the "High detail" capture mode: how much the camera is
 * asked for, how many of those pixels are kept, and at what JPEG quality.
 *
 * Rapid capture grabs a video frame rather than a still, so the frame is the
 * ceiling on everything downstream — no later processing can recover detail
 * that was never captured. High detail asks the camera for more and keeps
 * more of it.
 *
 * High detail keeps 2850x2138 where standard keeps 2050x1538 — 6.1 MP
 * against 3.2 MP of a 4:3 frame — downscaled from the native frame with the
 * browser's area resample; 2850px is as far as the app decodes
 * (DECODE_MAX_EDGE in app.js), so the two move together. Nothing is filtered
 * on the way: the frame is resampled and encoded, and that is all. The 4:3
 * frame holds 1.33x the pixels of the 16:9 one it replaced, which by the
 * measure below is 1.21x the bytes. Each profile spends a 1.3x byte
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
  //
  // Both profiles ask for a 4:3 frame. A phone's sensor is 4:3 and its 16:9
  // video modes are crops of it, and a page is about 1.41:1: a portrait A4
  // page filling a 16:9 frame capped at 2850px gets 1603x2267 of it, 3.6 MP;
  // filling a 4:3 frame, 2015x2850, 5.7 MP — 58% more of the kept pixels on
  // the page, at the same long edge. `fallbackVideo` is the 16:9 request the
  // camera falls back to when the 4:3 frame it is handed would put fewer
  // pixels on a page than that (CameraStream: a phone that offers 4:3 only
  // at a small size).
  const STANDARD_PROFILE = {
    maxEdge: 2050,
    jpegQuality: 0.84,
    video: { width: { ideal: 2560 }, height: { ideal: 1920 }, aspectRatio: { ideal: 4 / 3 } },
    fallbackVideo: { width: { ideal: 2560 }, height: { ideal: 1440 } },
  };

  // Asks for more than it keeps on purpose: downscaling from a larger frame
  // averages out sensor noise and aliasing, so 2850px taken from a 4032px
  // frame is cleaner than 2850px taken from a 2850px one.
  //
  // `frameRate: 60` is the shutter-speed request: a stream running at 60fps
  // cannot expose a frame for longer than 1/60s, which is what keeps a
  // handheld shot from smearing. It is an `ideal` rather than a `min` so it
  // can never reject the camera outright — the cost of that safety is that the
  // browser balances it against the size ideals rather than obeying a
  // priority, so a camera that offers 4:3 at full size only below 60fps may
  // be handed the full size at 30fps. That trade is deliberate: the pixels
  // on the page are the ceiling on everything downstream, while a shaken
  // frame is what the sharpest-of-seven pick and the auto shutter's wait for
  // a steady outline are there to avoid. The short exposure means a higher
  // ISO and some sensor grain; that grain is kept as captured, and the
  // downscale from the larger frame averages most of it away.
  const HIGH_DETAIL_PROFILE = {
    maxEdge: 2850,
    jpegQuality: 0.90,
    video: {
      width: { ideal: 4032 },
      height: { ideal: 3024 },
      aspectRatio: { ideal: 4 / 3 },
      frameRate: { ideal: 60 },
    },
    fallbackVideo: {
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
