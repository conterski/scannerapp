/* scan-enhance.js — the "Natural flash" setting: whether saved scans get a
 * local-contrast lift that makes paper read white and ink read dark.
 *
 * Off by default, and deliberately so. CRITERIA.md rule 7 and the README
 * promise that pixel colours are never altered, only geometry; that promise
 * holds unless the user opts in here. The enhancement itself lives in the
 * worker (worker/enhance.js) — this module owns only the choice.
 *
 * Exposes window.ScanEnhance.
 */
(function () {
  "use strict";

  const flag = PersistedFlag.create({
    storageKey: "scannerapp:naturalFlash",
    label: "natural-flash",
    defaultEnabled: false,
  });

  window.ScanEnhance = {
    loadPersistedSetting: flag.load,
    isEnabled: flag.isEnabled,
    setEnabled: flag.setEnabled,
  };
})();
