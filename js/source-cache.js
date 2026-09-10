/* source-cache.js — decoded full-resolution originals, held only for the page
 * being edited and its immediate neighbours.
 *
 * Decoding a 12 MP photo is the slow part of opening a page, so the pages the
 * editor's arrows can reach are decoded ahead of the tap. The window is small
 * because every entry is a large canvas, and iOS Safari is quick to discard a
 * tab that holds several of them.
 *
 * Exposes window.SourceCache — `create(decode)` per editing session, so no
 * decoded photo outlives the session that needed it.
 */
(function () {
  "use strict";

  // The page being edited first: its decode is the one the user is waiting on.
  // The neighbours follow, in the order the arrows are most likely to go.
  const PREFETCH_OFFSETS = [0, 1, -1];

  /** @param decode (page) => Promise<canvas> — the caller owns decode policy
   *                 (size caps, orientation); this module owns only the cache */
  function create(decode) {
    const entries = new Map(); // page.id -> { promise, canvas|null }

    function entryFor(page) {
      const cached = entries.get(page.id);
      if (cached) {
        entries.delete(page.id); // re-inserting refreshes LRU order
        entries.set(page.id, cached);
        return cached;
      }
      const entry = { promise: null, canvas: null };
      entry.promise = decode(page).then((canvas) => {
        entry.canvas = canvas;
        return canvas;
      });
      // A prefetched neighbour is never awaited, so its rejection has to be
      // marked handled; awaiting it later still throws.
      PromiseUtils.markRejectionHandled(entry.promise);
      entries.set(page.id, entry);
      return entry;
    }

    /** The decoded canvas if it is already in hand, else null. Lets a caller
     *  open instantly instead of showing a spinner for work already done. */
    function cached(page) {
      const entry = entries.get(page.id);
      return entry ? entry.canvas : null;
    }

    /** Starts the decode if it hasn't started, and resolves with the canvas. */
    function get(page) { return entryFor(page).promise; }

    /** Decodes the page at `centerIndex` and its neighbours, and drops every
     *  other entry — this is what bounds the cache. */
    function keepAround(pages, centerIndex) {
      const keep = new Set();
      for (const offset of PREFETCH_OFFSETS) {
        const page = pages[centerIndex + offset];
        if (!page) continue;
        keep.add(page.id);
        entryFor(page);
      }
      for (const id of [...entries.keys()]) {
        if (!keep.has(id)) entries.delete(id); // the canvas is GC'd once unreferenced
      }
    }

    function clear() { entries.clear(); }

    return { cached, get, keepAround, clear };
  }

  window.SourceCache = { create };
})();
