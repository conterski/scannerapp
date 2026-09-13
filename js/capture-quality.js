/* capture-quality.js — the "High detail" capture mode: how much the camera is
 * asked for, how many of those pixels are kept, at what JPEG quality, and
 * whether the frame is denoised on the way.
 *
 * Rapid capture grabs a video frame rather than a still, so the frame is the
 * ceiling on everything downstream — no later processing can recover detail
 * that was never captured. High detail asks the camera for more, keeps more of
 * it, and pays for the pixels with a lower JPEG quality.
 *
 * The numbers are measured on the real pipeline, not modelled. High detail
 * keeps 2400x1350 where standard keeps 1600x900 — 3.2 MP against 1.4 MP —
 * at JPEG quality 0.85, downscaled from the native frame with the
 * browser's area resample. Denoising removes the grain JPEG would otherwise
 * spend bits on, which is what makes the pixels this cheap. The budget went
 * on pixels rather than encoder quality on purpose: on the sample set, 2400px
 * at 0.85 costs 13% more bytes than 2200px did, while 2200px at 0.90 would
 * have cost 26% for a far smaller visible gain; 2500px at 0.85 measured 20%,
 * the whole allowance with nothing left for a noisier frame.
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
    denoise: false,
    video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  };

  // Asks for more than it keeps on purpose: downscaling from a larger frame
  // averages out sensor noise and aliasing, so 2400px taken from a 2560px
  // frame is cleaner than 2400px taken from a 2400px one. 2560x1440 rather
  // than 4K because too high an `ideal` can make Safari choose a
  // low-framerate capture mode, which is exactly what `frameRate` fights.
  //
  // `frameRate: 60` is the shutter-speed request: a stream running at 60fps
  // cannot expose a frame for longer than 1/60s, which is what keeps a
  // handheld shot from smearing. It is an `ideal` rather than a `min` so it
  // can never reject the camera outright — the cost of that safety is that the
  // browser balances it against the size ideals rather than obeying a
  // priority, so a camera that reaches 60fps only at a lower resolution will
  // hand back a smaller frame. That trade is deliberate: a blurred photo can't
  // be recovered, a slightly smaller one still reads.
  //
  // `denoise` pays for the short exposure. A brief exposure means a higher ISO
  // and visible sensor grain, and the filter that removes it has to run on the
  // full frame before the downscale — see CameraStream.captureJpeg.
  const HIGH_DETAIL_PROFILE = {
    maxEdge: 2400,
    jpegQuality: 0.85,
    denoise: true,
    video: {
      width: { ideal: 2560 },
      height: { ideal: 1440 },
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
