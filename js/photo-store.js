/* photo-store.js — storage for one capture session: the shots in capture
 * order, each with the viewfinder outline it was taken under, plus the
 * object URLs used to preview them. This module is the only place those URLs
 * are created or revoked.
 *
 * Exposes window.PhotoStore. `create()` is a factory — a store belongs to the
 * session that created it and is passed explicitly to whoever needs it.
 */
(function () {
  "use strict";

  const FILE_PREFIX = "scan-";
  const MIME = "image/jpeg";

  /** Older Safari can't construct File; a Blob carries the same bytes and is
   *  accepted everywhere we hand these on. */
  function toFile(blob, name) {
    try {
      return new File([blob], name, { type: blob.type || MIME, lastModified: Date.now() });
    } catch (e) {
      return blob;
    }
  }

  function create() {
    const shots = []; // { id, blob, url, viewfinderCorners } in capture order
    let nextId = 1;

    /** @param viewfinderCorners the outline shown at the tap, as fractions of
     *                           the frame, or null when none was showing */
    function add(blob, viewfinderCorners) {
      const shot = { id: nextId++, blob, url: URL.createObjectURL(blob),
                     viewfinderCorners: viewfinderCorners || null };
      shots.push(shot);
      return shot;
    }

    function remove(id) {
      const i = shots.findIndex((s) => s.id === id);
      if (i < 0) return false;
      URL.revokeObjectURL(shots[i].url);
      shots.splice(i, 1);
      return true;
    }

    function list() { return shots.slice(); }
    function count() { return shots.length; }

    /** Hands the session's photos to the app as named files, each paired
     *  with its viewfinder outline. The files own their bytes, so the store
     *  may be disposed straight afterwards.
     *  @returns [{ file, viewfinderCorners }] */
    function toShots() {
      return shots.map((s, i) => ({
        file: toFile(s.blob, `${FILE_PREFIX}${i + 1}.jpg`),
        viewfinderCorners: s.viewfinderCorners,
      }));
    }

    /** Revokes every preview URL and empties the store. */
    function dispose() {
      for (const s of shots) URL.revokeObjectURL(s.url);
      shots.length = 0;
    }

    return { add, remove, list, count, toShots, dispose };
  }

  window.PhotoStore = { create };
})();
