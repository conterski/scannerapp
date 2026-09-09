/* page-scroll.js — the window's scroll position: remembering it across a view
 * swap, pinning it while a full-screen overlay is up, and jumping to either
 * end of the page.
 *
 * Swapping views loses the position on its own. Hiding the page list collapses
 * the document, the browser clamps the scroll to the shorter page, and coming
 * back lands at the top — so the position has to be stashed before the swap
 * and put back after the list is rendered again.
 *
 * Exposes window.PageScroll. One stashed position is enough: the editor is
 * only ever reached from the list, and the camera tears down before it hands
 * its photos back, so no two consumers hold the slot at once.
 */
(function () {
  "use strict";

  // Below this the document isn't really scrollable — a couple of pixels of
  // rounding shouldn't put jump buttons on screen.
  const SCROLLABLE_SLACK = 24;

  let stashedY = 0;
  let isFrozen = false;

  function remember() { stashedY = window.scrollY; }

  function restore() { window.scrollTo(0, stashedY); }

  /** Stops the page moving behind a full-screen overlay.
   *
   *  `overflow: hidden` on the body does not hold on iOS Safari; pinning the
   *  body does. A fixed body is not a containing block for fixed descendants,
   *  so the overlays and the jump buttons still position against the viewport.
   */
  function freeze() {
    if (isFrozen) return;
    isFrozen = true;
    remember();
    const style = document.body.style;
    style.position = "fixed";
    style.top = `-${stashedY}px`;
    style.width = "100%";
  }

  /** Undoes freeze(). Safe to call when nothing is frozen. */
  function thaw() {
    if (!isFrozen) return;
    isFrozen = false;
    const style = document.body.style;
    style.position = "";
    style.top = "";
    style.width = "";
    restore();
  }

  function isScrollable() {
    return document.documentElement.scrollHeight >
      window.innerHeight + SCROLLABLE_SLACK;
  }

  /** Jumps to one end of the page.
   *
   *  Instant rather than animated. `scroll-behavior: smooth` on the root would
   *  also animate restore() and the editor's jump to its own top, which must
   *  both be immediate, and scrollTo's own `behavior` option is honoured
   *  unevenly. A list long enough to need these buttons is also long enough
   *  that animating the whole way is a wait, not a courtesy.
   *
   *  @param end "top" or "bottom"
   */
  function jumpTo(end) {
    window.scrollTo(0, end === "top" ? 0 : document.documentElement.scrollHeight);
  }

  window.PageScroll = { remember, restore, freeze, thaw, isScrollable, jumpTo };
})();
