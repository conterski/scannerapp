/* store.js — IndexedDB persistence of the scanning session, so pages survive a
 * reload, an accidental close, or iOS Safari evicting the backgrounded tab.
 *
 * Layout (three stores, keyed by page id):
 *   blobs {id, blob}                              — the original photo, written
 *                                                   once and never rewritten
 *   pages {id, corners, quarter, outputBlob}      — lightweight edit state plus
 *                                                   the rendered scan
 *   meta  {key:"order", ids:[...]}                — page order
 *
 * Every method returns a promise; callers fire-and-forget and swallow failures
 * so persistence can never break the app (private mode, quota, and so on).
 * Exposes window.Store.
 */
(function () {
  "use strict";

  const DB_NAME = "scannerapp";
  const DB_VERSION = 1;

  const BLOB_STORE = "blobs";
  const PAGE_STORE = "pages";
  const META_STORE = "meta";
  const ORDER_KEY = "order";
  const ALL_STORES = [BLOB_STORE, PAGE_STORE, META_STORE];

  let databasePromise = null;

  // ---------------------------------------------------------------
  // Session records
  // ---------------------------------------------------------------

  /** New page: store its original blob (once) plus its edit/output state. */
  function addPage(page) {
    return runTransaction([BLOB_STORE, PAGE_STORE], "readwrite", (transaction) => {
      transaction.objectStore(BLOB_STORE).put({ id: page.id, blob: page.blob });
      transaction.objectStore(PAGE_STORE).put(pageRecord(page));
    });
  }

  /** An edit landed (corners/rotation/output) — the original blob is untouched. */
  function savePage(page) {
    return runTransaction([PAGE_STORE], "readwrite", (transaction) => {
      transaction.objectStore(PAGE_STORE).put(pageRecord(page));
    });
  }

  /** Persists the current page order (call after add/remove/reorder). */
  function saveOrder(pages) {
    return runTransaction([META_STORE], "readwrite", (transaction) => {
      transaction.objectStore(META_STORE).put({
        key: ORDER_KEY, ids: pages.map((page) => page.id),
      });
    });
  }

  function removePage(id) {
    return runTransaction([BLOB_STORE, PAGE_STORE], "readwrite", (transaction) => {
      transaction.objectStore(BLOB_STORE).delete(id);
      transaction.objectStore(PAGE_STORE).delete(id);
    });
  }

  function clear() {
    return runTransaction(ALL_STORES, "readwrite", (transaction) => {
      for (const storeName of ALL_STORES) transaction.objectStore(storeName).clear();
    });
  }

  /**
   * Loads the saved session in page order. A record is skipped unless BOTH its
   * blob and its metadata are present, which makes partial or racing writes
   * self-healing rather than corrupting.
   * @returns Promise<Array<{id, blob, corners, quarter, outputBlob}>>
   */
  function loadAll() {
    return runTransaction(ALL_STORES, "readonly", async (transaction) => {
      const [pageRecords, blobRecords, orderRecord] = await Promise.all([
        requestToPromise(transaction.objectStore(PAGE_STORE).getAll()),
        requestToPromise(transaction.objectStore(BLOB_STORE).getAll()),
        requestToPromise(transaction.objectStore(META_STORE).get(ORDER_KEY)),
      ]);
      return joinRecordsInOrder(pageRecords, blobRecords, orderRecord);
    });
  }

  function joinRecordsInOrder(pageRecords, blobRecords, orderRecord) {
    const pageById = new Map(pageRecords.map((record) => [record.id, record]));
    const blobById = new Map(blobRecords.map((record) => [record.id, record.blob]));
    const orderedIds = (orderRecord && orderRecord.ids) ||
      pageRecords.map((record) => record.id);

    const restored = [];
    for (const id of orderedIds) {
      const page = pageById.get(id);
      const blob = blobById.get(id);
      if (page && blob) {
        restored.push({
          id, blob, corners: page.corners,
          quarter: page.quarter, outputBlob: page.outputBlob,
        });
      }
    }
    return restored;
  }

  /** The stored schema calls it `quarter`; the app calls it `quarterTurns`.
   *  Renaming the stored key would orphan every already-saved session. */
  function pageRecord(page) {
    return {
      id: page.id,
      corners: page.corners,
      quarter: page.quarterTurns,
      outputBlob: page.outputBlob,
    };
  }

  // ---------------------------------------------------------------
  // IndexedDB plumbing
  // ---------------------------------------------------------------

  function openDB() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => createStores(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    databasePromise.catch(() => { databasePromise = null; }); // allow a later retry
    return databasePromise;
  }

  function createStores(database) {
    for (const storeName of ALL_STORES) {
      if (database.objectStoreNames.contains(storeName)) continue;
      database.createObjectStore(storeName, { keyPath: storeName === META_STORE ? "key" : "id" });
    }
  }

  /** `work` must issue all of its requests synchronously — an IndexedDB
   *  transaction auto-commits as soon as it goes idle. */
  async function runTransaction(storeNames, mode, work) {
    const database = await openDB();
    const transaction = database.transaction(storeNames, mode);
    const result = await work(transaction);
    await whenTransactionCompletes(transaction);
    return result;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function whenTransactionCompletes(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function detectIndexedDBSupport() {
    try {
      return Boolean(self.indexedDB);
    } catch (error) {
      return false; // some privacy modes throw on the mere property access
    }
  }

  window.Store = {
    isAvailable: detectIndexedDBSupport(),
    addPage, savePage, saveOrder, removePage, clear, loadAll,
  };
})();
