/* scan-enhance.js — the "Natural flash" setting: whether saved scans get the
 * readability pass that makes paper read white and ink read crisp.
 *
 * Off by default, and deliberately so. CRITERIA.md rule 7 and the README
 * promise that pixel colours are never altered, only geometry; that promise
 * holds unless the user opts in here. The filter itself lives in
 * js/gpu-enhance.js — this module owns only the choice, and app.js hides the
 * setting on a device that cannot run it.
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
