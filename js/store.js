/* store.js — IndexedDB persistence of the scanning session so pages survive
 * a reload, an accidental close, or iOS Safari evicting the backgrounded tab.
 *
 * Layout (three stores, keyed by page id):
 *   blobs {id, blob}                              — the original photo, written
 *                                                   once and never rewritten
 *   pages {id, corners, quarter, outputBlob}      — lightweight edit state +
 *                                                   the rendered scan
 *   meta  {key:"order", ids:[...]}                — page order
 *
 * Every method resolves/rejects a promise; callers fire-and-forget and swallow
 * errors so persistence can never break the app (private mode, quota, etc.).
 * Exposes window.Store.
 */
(function () {
  "use strict";

  const DB_NAME = "scannerapp";
  const VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, VERSION);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; }); // allow a later retry
    return dbPromise;
  }

  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  function txDone(t) {
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  function pageRecord(page) {
    return { id: page.id, corners: page.corners, quarter: page.quarter, outputBlob: page.outputBlob };
  }

  /** New page: store its original blob (once) plus its edit/output state. */
  async function addPage(page) {
    const db = await openDB();
    const t = db.transaction(["blobs", "pages"], "readwrite");
    t.objectStore("blobs").put({ id: page.id, blob: page.blob });
    t.objectStore("pages").put(pageRecord(page));
    await txDone(t);
  }

  /** Edit landed (corners/quarter/outputBlob) — the original blob is untouched. */
  async function savePage(page) {
    const db = await openDB();
    const t = db.transaction(["pages"], "readwrite");
    t.objectStore("pages").put(pageRecord(page));
    await txDone(t);
  }

  /** Persist the current page order (call after add/remove/reorder). */
  async function saveOrder(pages) {
    const db = await openDB();
    const t = db.transaction(["meta"], "readwrite");
    t.objectStore("meta").put({ key: "order", ids: pages.map((p) => p.id) });
    await txDone(t);
  }

  async function removePage(id) {
    const db = await openDB();
    const t = db.transaction(["blobs", "pages"], "readwrite");
    t.objectStore("blobs").delete(id);
    t.objectStore("pages").delete(id);
    await txDone(t);
  }

  async function clear() {
    const db = await openDB();
    const t = db.transaction(["blobs", "pages", "meta"], "readwrite");
    t.objectStore("blobs").clear();
    t.objectStore("pages").clear();
    t.objectStore("meta").clear();
    await txDone(t);
  }

  /**
   * Loads the saved session in page order. A record is skipped unless BOTH its
   * blob and its metadata are present, which makes partial/racing writes
   * self-healing rather than corrupting.
   * @returns Promise<Array<{id, blob, corners, quarter, outputBlob}>>
   */
  async function loadAll() {
    const db = await openDB();
    const t = db.transaction(["blobs", "pages", "meta"], "readonly");
    const [pages, blobs, orderRec] = await Promise.all([
      reqP(t.objectStore("pages").getAll()),
      reqP(t.objectStore("blobs").getAll()),
      reqP(t.objectStore("meta").get("order")),
    ]);
    const pageById = new Map(pages.map((p) => [p.id, p]));
    const blobById = new Map(blobs.map((b) => [b.id, b.blob]));
    const ids = (orderRec && orderRec.ids) || pages.map((p) => p.id);
    const out = [];
    for (const id of ids) {
      const p = pageById.get(id), blob = blobById.get(id);
      if (p && blob) out.push({ id, blob, corners: p.corners, quarter: p.quarter, outputBlob: p.outputBlob });
    }
    return out;
  }

  window.Store = {
    available: (function () { try { return !!self.indexedDB; } catch (e) { return false; } })(),
    addPage, savePage, saveOrder, removePage, clear, loadAll,
  };
})();
