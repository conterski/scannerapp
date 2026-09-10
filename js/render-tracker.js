/* render-tracker.js — the bookkeeping around re-rendering pages: which render
 * is the current one for a page, and which renders are still in flight.
 *
 * Both exist because a render outlives the edit that asked for it. A slow warp
 * must not overwrite the output of the edit that replaced it, and an export
 * must not bundle a page whose render hasn't landed yet.
 *
 * Exposes window.RenderTracker.
 */
(function () {
  "use strict";

  function create() {
    const currentToken = new Map(); // page id -> the newest render's token
    const inFlight = new Set();     // renders running off the critical path

    /**
     * Claims a page's render slot for the caller.
     * @returns () => boolean — false once a newer render has claimed the slot,
     *          which is the signal to drop this render's result rather than
     *          publish it over the newer one.
     */
    function claim(pageId) {
      const token = (currentToken.get(pageId) || 0) + 1;
      currentToken.set(pageId, token);
      return () => currentToken.get(pageId) === token;
    }

    /** Drops a page's slot. For a page being deleted — not for one whose
     *  render is merely being replaced, which claim() already handles. */
    function forget(pageId) { currentToken.delete(pageId); }

    /** Registers a background render so whenSettled() waits for it. */
    function track(render) {
      inFlight.add(render);
      // then(f, f) rather than finally(f): finally returns a NEW promise that
      // rejects whenever `render` does, and nothing handles that one.
      const forgetRender = () => inFlight.delete(render);
      render.then(forgetRender, forgetRender);
      return render;
    }

    /** Loops rather than awaiting one snapshot: a render scheduled while we
     *  were waiting (a session restore finishing its OpenCV load, say) has to
     *  be caught too, or an export bundles a page whose output is still null. */
    async function whenSettled() {
      while (inFlight.size) {
        await Promise.allSettled([...inFlight]);
      }
    }

    return { claim, forget, track, whenSettled };
  }

  window.RenderTracker = { create };
})();
