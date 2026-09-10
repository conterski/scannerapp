/* app-chrome.js — the two pieces of feedback the app shows over whatever the
 * user is doing: the blocking busy overlay and the transient status line.
 *
 * Busy work is a scope rather than a pair of calls. Two long jobs can overlap
 * — compressing every scan while a batch of photos is still being added, say —
 * and a plain show/hide pair lets whichever finishes first take the overlay
 * down while the other is still working. A scope stays counted until it ends,
 * so the overlay is up exactly as long as something is behind it.
 *
 * Exposes window.AppChrome.
 */
(function () {
  "use strict";

  const STATUS_MESSAGE_MS = 6000;

  const $ = (id) => document.getElementById(id);

  const activeScopes = []; // oldest first; the newest one owns the message
  let statusTimer = 0;

  /**
   * Puts the busy overlay up and keeps it up until the returned scope ends.
   * @returns { update(text), end() } — `end` is idempotent, so it is safe in
   *          a finally that also runs on an early return.
   */
  function beginBusy(text) {
    const scope = { text };
    activeScopes.push(scope);
    paintBusy();
    return {
      update(nextText) {
        scope.text = nextText;
        paintBusy();
      },
      end() {
        const index = activeScopes.indexOf(scope);
        if (index < 0) return;
        activeScopes.splice(index, 1);
        paintBusy();
      },
    };
  }

  /** The newest scope's message wins: it is the one the user just started. */
  function paintBusy() {
    const newest = activeScopes[activeScopes.length - 1];
    if (newest) $("busyText").textContent = newest.text;
    $("busyOverlay").hidden = !newest;
  }

  function setStatus(text) {
    const status = $("statusText");
    status.textContent = text;
    status.hidden = !text;
  }

  /** Clears the previous timer first: without that, two messages in quick
   *  succession leave the first one's timer to wipe the second early. */
  function showTemporaryStatus(text) {
    setStatus(text);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => setStatus(""), STATUS_MESSAGE_MS);
  }

  window.AppChrome = { beginBusy, setStatus, showTemporaryStatus };
})();
