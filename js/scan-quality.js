/* scan-quality.js — the "Compact scans" storage mode: the resolution and JPEG
 * quality saved scans are written at, and the persistence of that choice.
 * Compact trades resolution and quality for much smaller saved files.
 * Exposes window.ScanQuality.
 */
(function () {
  "use strict";

  const STANDARD_PROFILE = { maxDim: 2500, quality: 0.92 };
  const COMPACT_PROFILE = { maxDim: 1600, quality: 0.72 };

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
