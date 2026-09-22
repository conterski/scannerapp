/* store.js — IndexedDB persistence of the scanning session, so pages survive a
 * reload, an accidental close, or iOS Safari evicting the backgrounded tab.
 *
 * Layout (three stores, keyed by page id):
 *   blobs {id, blob}                              — the original photo, written
 *                                                   once and never rewritten
 *   pages {id, corners, viewfinderCorners,        — lightweight edit state plus
 *          quarter, outputBlob}                     the rendered scan
 *   meta  {key:"order" | "order:<tab>", ids,      — one record per tab: its
 *          notes}                                    page order and its two
 *                                                    message boxes
 *
 * A tab is its order record: the pages it lists, in that order, and the
 * messages typed above them. Tab 1 keeps the key every session saved before
 * tabs existed already has. A tab with no pages has no record — it exists
 * only while it is on screen. Page ids are unique across tabs, so a page and
 * its blob never need to say which tab they belong to.
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

  const orderKey = (tab) => (tab === 1 ? ORDER_KEY : `${ORDER_KEY}:${tab}`);
  const tabOf = (key) => (key === ORDER_KEY ? 1 : Number(key.slice(ORDER_KEY.length + 1)));

  /** Persists a tab: its page order and its message boxes (call after
   *  add/remove/reorder and on every edit of the boxes). A tab left with no
   *  pages loses its record, notes included: it is no tab until pages fill
   *  it again. */
  function saveOrder(pages, tab, notes) {
    return runTransaction([META_STORE], "readwrite", (transaction) => {
      const meta = transaction.objectStore(META_STORE);
      if (pages.length) meta.put({ key: orderKey(tab), ids: pages.map((page) => page.id), notes });
      else meta.delete(orderKey(tab));
    });
  }

  /** Every tab, every page: the whole session. */
  function clear() {
    return runTransaction(ALL_STORES, "readwrite", (transaction) => {
      for (const storeName of ALL_STORES) transaction.objectStore(storeName).clear();
    });
  }

  function removePages(ids) {
    return runTransaction([BLOB_STORE, PAGE_STORE], "readwrite", (transaction) => {
      for (const id of ids) {
        transaction.objectStore(BLOB_STORE).delete(id);
        transaction.objectStore(PAGE_STORE).delete(id);
      }
    });
  }

  /**
   * Loads one tab's pages in order, with the tabs there are and the highest
   * page id in use anywhere. A record is skipped unless BOTH its blob and its
   * metadata are present, which makes partial or racing writes self-healing
   * rather than corrupting. A tab with no record loads empty — that is how a
   * new tab starts. Pages listed by no tab are restored only while no tab
   * has a record at all: a session from before the order record existed.
   * @returns Promise<{ pages: [{id, blob, corners, viewfinderCorners, quarter,
   *          outputBlob}], tabs: [1, …] ascending, maxId, notes: [text, text]
   *          or null when the tab has none saved }>
   */
  function loadAll(tab) {
    return runTransaction(ALL_STORES, "readonly", async (transaction) => {
      const [pageRecords, blobRecords, metaRecords] = await Promise.all([
        requestToPromise(transaction.objectStore(PAGE_STORE).getAll()),
        requestToPromise(transaction.objectStore(BLOB_STORE).getAll()),
        requestToPromise(transaction.objectStore(META_STORE).getAll()),
      ]);
      const orders = metaRecords.filter((record) => record.key.startsWith(ORDER_KEY));
      const order = orders.find((record) => record.key === orderKey(tab));
      const ids = order ? order.ids : orders.length ? [] : pageRecords.map((record) => record.id);
      return {
        pages: joinRecordsInOrder(pageRecords, blobRecords, ids),
        tabs: [...new Set([1, tab, ...orders.map((record) => tabOf(record.key))])].sort((a, b) => a - b),
        // Over every tab's listing too: a page whose write failed is still listed, and its id is still taken.
        maxId: Math.max(0, ...pageRecords.map((record) => record.id), ...orders.flatMap((record) => record.ids)),
        notes: (order && order.notes) || null, // absent in sessions saved before the boxes existed
      };
    });
  }

  function joinRecordsInOrder(pageRecords, blobRecords, orderedIds) {
    const pageById = new Map(pageRecords.map((record) => [record.id, record]));
    const blobById = new Map(blobRecords.map((record) => [record.id, record.blob]));

    const restored = [];
    for (const id of orderedIds) {
      const page = pageById.get(id);
      const blob = blobById.get(id);
      if (page && blob) {
        restored.push({
          id, blob, corners: page.corners, viewfinderCorners: page.viewfinderCorners || null,
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
      viewfinderCorners: page.viewfinderCorners || null, // absent in sessions saved before it existed
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
    addPage, savePage, saveOrder, removePages, clear, loadAll,
  };
})();
