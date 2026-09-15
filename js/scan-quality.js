/* scan-quality.js — the "Compact scans" storage mode: the resolution and JPEG
 * quality saved scans are written at, and the persistence of that choice.
 * Compact trades resolution and quality for much smaller saved files.
 * Exposes window.ScanQuality.
 */
(function () {
  "use strict";

  // Each profile spends a 1.3x byte allowance over the one before it on
  // pixels first and quality second, measured on rendered scans of twelve
  // sample photos (bytes grow as pixels to the power 0.67 at a fixed quality;
  // a quality step of 0.01 is 3–11% more, steeper the higher it goes).
  // Standard sits at the app's decode size (DECODE_MAX_EDGE in app.js) and
  // moves with it: 2500px at 0.92 went to 0.95 (1.30x), then to 2850px where
  // the pixels alone are 1.19x and a step to 0.96 would have made it 1.32x.
  // Compact: 1600px at 0.72 went to 1800px at 0.76 (1.27x), then 2050px at
  // 0.78 (1.19x for the pixels, 1.27x with the quality).
  const STANDARD_PROFILE = { maxDim: 2850, quality: 0.95 };
  const COMPACT_PROFILE = { maxDim: 2050, quality: 0.78 };

  // Compact re-encodes the stored original at low quality but keeps its
  // resolution, so each page's detected corners stay valid against it.
  const COMPACT_ORIGINAL_QUALITY = 0.6;

  const flag = PersistedFlag.create({
    storageKey: "scannerapp:compact",
    label: "compact-scans",
    defaultEnabled: false,
  });

  function currentProfile() {
    return flag.isEnabled() ? COMPACT_PROFILE : STANDARD_PROFILE;
  }

  window.ScanQuality = {
    loadPersistedSetting: flag.load,
    isEnabled: flag.isEnabled,
    setEnabled: flag.setEnabled,
    currentProfile,
    COMPACT_ORIGINAL_QUALITY,
  };
})();
