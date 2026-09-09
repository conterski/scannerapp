/* persisted-flag.js — an on/off setting that survives a reload.
 *
 * localStorage throws outright in private mode, so every read and write is
 * guarded. A failure falls back to the setting's own declared default: if
 * nothing could be stored then the user never changed it, and the app's
 * intended default is the honest answer.
 *
 * Exposes window.PersistedFlag. `create()` is a factory — each setting gets its
 * own flag, so no state is shared between them.
 */
(function () {
  "use strict";

  const STORED_ENABLED = "1";
  const STORED_DISABLED = "0";

  /**
   * @param options { storageKey, label, defaultEnabled } — `label` names the
   *                setting in the warning shown when storage is unavailable
   */
  function create(options) {
    const { storageKey, label, defaultEnabled } = options;
    let isOn = defaultEnabled;

    function read() {
      try {
        const stored = localStorage.getItem(storageKey);
        return stored === null ? defaultEnabled : stored === STORED_ENABLED;
      } catch (error) {
        console.warn(`Couldn't read the ${label} setting:`, error);
        return defaultEnabled;
      }
    }

    function write(enabled) {
      try {
        localStorage.setItem(storageKey, enabled ? STORED_ENABLED : STORED_DISABLED);
      } catch (error) {
        console.warn(`Couldn't save the ${label} setting:`, error);
      }
    }

    return {
      load() { isOn = read(); },
      isEnabled() { return isOn; },
      setEnabled(enabled) { isOn = enabled; write(enabled); },
    };
  }

  window.PersistedFlag = { create };
})();
