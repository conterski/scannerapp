/* persisted-flag.js — an on/off setting that survives a reload.
 *
 * localStorage throws outright in private mode, so every read and write is
 * guarded and a failure falls back to "off": these flags are opt-in, and if
 * nothing could be saved then nothing was ever turned on.
 *
 * Exposes window.PersistedFlag. `create()` is a factory — each setting gets its
 * own flag, so no state is shared between them.
 */
(function () {
  "use strict";

  const STORED_ENABLED = "1";
  const STORED_DISABLED = "0";

  /**
   * @param storageKey  localStorage key to persist under
   * @param label       human name, used only in the warning when storage fails
   */
  function create(storageKey, label) {
    let isOn = false;

    function read() {
      try {
        return localStorage.getItem(storageKey) === STORED_ENABLED;
      } catch (error) {
        console.warn(`Couldn't read the ${label} setting:`, error);
        return false;
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
