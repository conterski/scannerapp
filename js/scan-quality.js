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

  const STORAGE_KEY = "scannerapp:compact";
  const STORED_ENABLED = "1";
  const STORED_DISABLED = "0";

  let isCompactEnabled = false;

  /** localStorage throws outright in private mode, where "off" is the honest
   *  answer — compact is opt-in and nothing was ever saved there. */
  function readPersistedSetting() {
    try {
      return localStorage.getItem(STORAGE_KEY) === STORED_ENABLED;
    } catch (error) {
      console.warn("Couldn't read the compact-scans setting:", error);
      return false;
    }
  }

  function writePersistedSetting(enabled) {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? STORED_ENABLED : STORED_DISABLED);
    } catch (error) {
      console.warn("Couldn't save the compact-scans setting:", error);
    }
  }

  function loadPersistedSetting() { isCompactEnabled = readPersistedSetting(); }

  function isEnabled() { return isCompactEnabled; }

  function setEnabled(enabled) {
    isCompactEnabled = enabled;
    writePersistedSetting(enabled);
  }

  function currentProfile() {
    return isCompactEnabled ? COMPACT_PROFILE : STANDARD_PROFILE;
  }

  window.ScanQuality = {
    loadPersistedSetting, isEnabled, setEnabled, currentProfile,
    COMPACT_ORIGINAL_QUALITY,
  };
})();
