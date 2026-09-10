/* promise-utils.js — the small bits of promise handling that more than one
 * module needs. Exposes window.PromiseUtils.
 */
(function () {
  "use strict";

  /** Marks a promise's rejection as handled without changing what it resolves
   *  to, for a promise that is deliberately started and never awaited — a
   *  prefetch, an engine warm-up, an autoplay attempt. Without this the
   *  browser reports an unhandled rejection for a failure the caller already
   *  copes with; the original promise is returned unchanged, so awaiting it
   *  later still throws.
   *
   *  A non-promise passes through: HTMLMediaElement.play() returns undefined
   *  on older browsers.
   */
  function markRejectionHandled(value) {
    if (value && typeof value.catch === "function") value.catch(() => {});
    return value;
  }

  window.PromiseUtils = { markRejectionHandled };
})();
