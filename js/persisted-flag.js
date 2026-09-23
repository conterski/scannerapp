/* persisted-flag.js — a small setting that survives a reload: an on/off flag,
 * or a whole number where a setting has more than two states.
 *
 * localStorage throws outright in private mode, so every read and write is
 * guarded. A failure falls back to the setting's own declared default: if
 * nothing could be stored then the user never changed it, and the app's
 * intended default is the honest answer.
 *
 * Exposes window.PersistedFlag. Both factories hand back their own state, so
 * nothing is shared between two settings.
 */
(function () {
  "use strict";

  const STORED_ENABLED = "1";
  const STORED_DISABLED = "0";

  /** The guarded pair both factories are built on: text in, text out, and a
   *  warning named after the setting when the browser refuses either. */
  function createStorage(storageKey, label) {
    return {
      read() {
        try {
          return localStorage.getItem(storageKey);
        } catch (error) {
          console.warn(`Couldn't read the ${label} setting:`, error);
          return null;
        }
      },
      write(text) {
        try {
          localStorage.setItem(storageKey, text);
        } catch (error) {
          console.warn(`Couldn't save the ${label} setting:`, error);
        }
      },
    };
  }

  /**
   * An on/off setting.
   * @param options { storageKey, label, defaultEnabled } — `label` names the
   *                setting in the warning shown when storage is unavailable
   */
  function create(options) {
    const { storageKey, label, defaultEnabled } = options;
    const storage = createStorage(storageKey, label);
    let isOn = defaultEnabled;

    return {
      load() {
        const stored = storage.read();
        isOn = stored === null ? defaultEnabled : stored === STORED_ENABLED;
      },
      isEnabled() { return isOn; },
      setEnabled(enabled) {
        isOn = enabled;
        storage.write(enabled ? STORED_ENABLED : STORED_DISABLED);
      },
    };
  }

  /**
   * A whole-number setting, for one with more than two states.
   * @param options { storageKey, label, defaultValue }
   */
  function createNumber(options) {
    const { storageKey, label, defaultValue } = options;
    const storage = createStorage(storageKey, label);
    let value = defaultValue;

    return {
      load() {
        // Anything but an integer — absent, empty, or left by an older
        // version — means the user has not set this, so the default stands.
        // Parsed rather than coerced: Number(null) and Number("") are both 0,
        // which would read as a genuine stored zero.
        const stored = parseInt(storage.read(), 10);
        value = Number.isInteger(stored) ? stored : defaultValue;
      },
      get() { return value; },
      set(next) {
        value = next;
        storage.write(String(next));
      },
    };
  }

  window.PersistedFlag = { create, createNumber };
})();
