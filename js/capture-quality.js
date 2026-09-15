/* capture-quality.js — the "High detail" capture mode: how much the camera is
 * asked for, how many of those pixels are kept, at what JPEG quality, and
 * whether the frame is denoised on the way.
 *
 * Rapid capture grabs a video frame rather than a still, so the frame is the
 * ceiling on everything downstream — no later processing can recover detail
 * that was never captured. High detail asks the camera for more, keeps more of
 * it, and cleans it so the encoder spends its bytes on detail.
 *
 * High detail keeps 2850x1603 where standard keeps 2050x1153 — 4.6 MP
 * against 2.4 MP — downscaled from the native frame with the browser's area
 * resample; 2850px is as far as the app decodes (DECODE_MAX_EDGE in app.js),
 * so the two move together. Denoising removes the grain JPEG would otherwise
 * spend bits on, which is what makes the pixels this cheap. Each profile
 * spends a 1.3x byte allowance over the one before it on pixels first and
 * encoder quality second. Measured over twelve sample photos: at a fixed
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
    denoise: false,
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
  //
  // `denoise` pays for the short exposure. A brief exposure means a higher ISO
  // and visible sensor grain, and the filter that removes it has to run on the
  // full frame before the downscale — see CameraStream.captureJpeg.
  const HIGH_DETAIL_PROFILE = {
    maxEdge: 2850,
    jpegQuality: 0.90,
    denoise: true,
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
