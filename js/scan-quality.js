/* scan-quality.js — the "Compact scans" storage mode: the resolution and JPEG
 * quality saved scans are written at, and the persistence of that choice.
 * Compact trades resolution and quality for much smaller saved files.
 * Exposes window.ScanQuality.
 */
(function () {
  "use strict";

  // Each 1.3x the bytes of its predecessor (2500px at 0.92, 1600px at 0.72),
  // measured on rendered scans of twelve sample photos: standard is already
  // at the app's decode size, so its allowance went to quality — 0.95 is
  // 1.30x, 0.96 would be 1.44x; compact went to pixels first, 1800px at 0.76
  // being 1.27x where 0.77 would be 1.31x.
  const STANDARD_PROFILE = { maxDim: 2500, quality: 0.95 };
  const COMPACT_PROFILE = { maxDim: 1800, quality: 0.76 };

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
