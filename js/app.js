/* app.js — orchestration: the add-photos pipeline, the editor navigation loop,
 * the capture hand-off, export wiring and session restore. Image work lives in
 * ImageUtils, quality settings in ScanQuality, the grid in PageListView, the
 * warp in ScanRenderer, persistence in Store.
 */
(function () {
  "use strict";

  // Bounds decoded photos so iOS Safari doesn't run out of canvas memory with
  // many 12 MP originals. Standard-quality scans are capped at the same size,
  // which makes the output cap a no-op unless Compact is on.
  const DECODE_MAX_EDGE = 2500;

  const STATUS_MESSAGE_MS = 6000;

  // Some pickers report no MIME type at all, so an extension is the fallback.
  // A type that IS present and isn't an image must still lose.
  const IMAGE_FILE_EXTENSIONS = /\.(jpe?g|png|gif|bmp|webp|heic|heif|avif|tiff?)$/i;

  /** @type {Array<{id:number, blob:Blob, corners:Object, quarterTurns:number,
   *  outputBlob:Blob, outputURL:string, renderedSig:string}>}
   *  Stored as `quarter` on disk — Store's page record maps the name. */
  const pages = [];
  let nextPageId = 1;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", async () => {
    Editor.init();
    ScanQuality.loadPersistedSetting();
    $("compactCheck").checked = ScanQuality.isEnabled();
    PageListView.init({
      onEditPage: editPage,
      onDeletePage: deletePage,
      onMovePage: movePage,
      onDeleteSelected: deleteSelectedPages,
      onClearAll: clearAllPages,
      onSelectModeChanged: renderPageList,
    });
    wirePhotoInputs();
    wireQualityToggle();
    wireExportControls();
    await restoreSavedSession(); // repopulate pages before the first paint
    renderPageList();
  });

  function wirePhotoInputs() {
    const fileInput = $("fileInput");
    const cameraInput = $("cameraInput");
    $("addPhotosBtn").addEventListener("click", () => {
      preloadScannerEngine();
      fileInput.click();
    });
    $("cameraBtn").addEventListener("click", () => {
      preloadScannerEngine();
      startCapture(cameraInput);
    });
    fileInput.addEventListener("change", () => {
      addFiles(fileInput.files);
      fileInput.value = "";
    });
    // Fallback path only (no in-page camera): the system camera returns one
    // photo per trip, with its own Retake/Use Photo confirmation.
    cameraInput.addEventListener("change", () => {
      const file = cameraInput.files[0]; // grab the ref BEFORE resetting value
      cameraInput.value = "";
      if (file) addFiles([file]);
    });
  }

  function wireQualityToggle() {
    $("compactCheck").addEventListener("change", async (event) => {
      await setCompactEnabled(event.target.checked);
      event.target.checked = ScanQuality.isEnabled(); // reverts if cancelled
    });
  }

  function wireExportControls() {
    $("pdfBtn").addEventListener("click", () => runExport({
      busyText: "Building PDF…",
      exportBlobs: () => Exporter.exportPdf(outputBlobs()),
      failurePrefix: "PDF export failed: ",
    }));
    $("photosBtn").addEventListener("click", () => runExport({
      busyText: "Preparing images…",
      exportBlobs: () => Exporter.exportPhotos(outputBlobs()),
      failurePrefix: "Export failed: ",
      onDownloadFallback: () =>
        showTemporaryStatus("Sharing unavailable — images downloaded in order instead."),
    }));

    if (!(navigator.canShare && navigator.share)) {
      $("exportHint").textContent =
        "Sharing isn't available in this browser — images will download in page order instead.";
    }
  }

  // ---------------------------------------------------------------
  // Adding photos
  // ---------------------------------------------------------------

  function isImageFile(file) {
    if (file.type) return file.type.startsWith("image/");
    return IMAGE_FILE_EXTENSIONS.test(file.name || "");
  }

  async function addFiles(fileList) {
    const selected = Array.from(fileList);
    const files = selected.filter(isImageFile);
    if (!files.length) {
      if (selected.length) {
        showTemporaryStatus(selected.length === 1
          ? "That file isn't an image — nothing was added."
          : "Those files aren't images — nothing was added.");
      }
      return;
    }
    showBusy(`Processing 1 / ${files.length}…`);
    setStatus("Loading OpenCV…");
    try {
      await Detect.ensureOpenCV();
    } catch (error) {
      console.error(error);
      setStatus("");
      hideBusy();
      alert("Couldn't load the scanner engine (OpenCV). Check your connection and try again.");
      return;
    }
    setStatus("");
    try {
      await addPhotoBatch(files);
      persistPageOrder();
    } finally {
      hideBusy();
    }
  }

  /** Pipelined: detection in the worker is the long pole, so the next photo's
   *  decode and the previous page's warp+encode run on the main thread while
   *  the worker detects — their cost hides almost entirely. */
  async function addPhotoBatch(files) {
    const renders = [];
    let nextDecode = decodeOrCaptureError(files[0]);
    for (let index = 0; index < files.length; index++) {
      showBusy(`Processing ${index + 1} / ${files.length}…`);
      const decoded = await nextDecode;
      if (index + 1 < files.length) nextDecode = decodeOrCaptureError(files[index + 1]);
      const page = await detectAndRegisterPage(files[index], decoded);
      if (page) renders.push(renderAndPersistNewPage(page, decoded, files[index]));
    }
    await Promise.all(renders);
  }

  /** A decode failure travels with the queue rather than rejecting it, so one
   *  unreadable photo cannot abort the whole batch. */
  function decodeOrCaptureError(file) {
    return ImageUtils.decodeImageToCanvas(file, DECODE_MAX_EDGE).catch((error) => error);
  }

  async function detectAndRegisterPage(file, decoded) {
    try {
      if (decoded instanceof Error) throw decoded;
      const corners = await Detect.detectCorners(decoded);
      const page = createPage(await blobToStore(file, decoded), corners);
      pages.push(page);
      return page;
    } catch (error) {
      reportPhotoFailure(file, error);
      return null;
    }
  }

  /** Deliberately not awaited by the batch loop: the render overlaps the next
   *  photo's detection, which is what makes the pipeline fast. */
  function renderAndPersistNewPage(page, decoded, file) {
    return regenerateOutput(page, decoded).then(() => {
      persist(Store.addPage(page)); // blob + rendered output survive a reload
      renderPageList();
    }, (error) => {
      discardPage(page);
      reportPhotoFailure(file, error);
    });
  }

  /** Compact stores a re-encoded (smaller) original; standard keeps the raw
   *  file. Resolution is unchanged either way, so the detected corners stay
   *  valid against the stored blob. */
  function blobToStore(file, decoded) {
    if (!ScanQuality.isEnabled()) return Promise.resolve(file);
    return ImageUtils.encodeCanvasToJpeg(decoded, ScanQuality.COMPACT_ORIGINAL_QUALITY);
  }

  function createPage(blob, corners) {
    return {
      id: nextPageId++,
      blob,
      corners,
      quarterTurns: 0,
      outputBlob: null,
      outputURL: null,
    };
  }

  function reportPhotoFailure(file, error) {
    console.error("Couldn't add photo:", error);
    alert(`Couldn't process "${file.name || "photo"}": ${error.message}`);
  }

  // ---------------------------------------------------------------
  // Rapid capture: the in-page camera (CaptureUI) runs the whole session and
  // hands back the shots in one go, so detection never runs between shots.
  // ---------------------------------------------------------------

  /** Starts OpenCV's ~11 MB load the moment the user reaches for a photo, so
   *  the batch doesn't wait on the compile after Done. Fire-and-forget: a
   *  failure here surfaces later, where it is already handled. */
  function preloadScannerEngine() {
    markRejectionHandled(Detect.ensureOpenCV());
  }

  /** Must be called straight from a user gesture — both getUserMedia and the
   *  native-input fallback require one. */
  function startCapture(cameraInput) {
    if (!CameraStream.isSupported()) { cameraInput.click(); return; }
    CaptureUI.open(PhotoStore.create(), { onFallback: () => cameraInput.click() })
      .then((files) => { if (files.length) addFiles(files); });
  }

  // ---------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------

  /** The editor's ◀/▶ arrows loop here: navigating applies the current page's
   *  edits (same as Done) and opens the adjacent page. Indices stay stable —
   *  the list is hidden while the editor is open. */
  async function editPage(startIndex) {
    PageListView.setToolbarVisible(false); // header actions don't apply while editing
    try {
      let index = startIndex;
      while (index !== null) index = await editOnePage(index);
    } finally {
      clearSourceCache();
      renderPageList();
    }
  }

  /** @returns the next index to open, or null when the session ends */
  async function editOnePage(index) {
    const page = pages[index];
    primeSources(index); // decode this page and its neighbours ahead of time
    const source = await sourceForEditing(page);
    if (!source) return null;
    const result = await Editor.open(source, page,
      { hasPrev: index > 0, hasNext: index < pages.length - 1 });
    if (!result) return null;
    applyEditorResult(page, result, source);
    return result.nav ? index + result.nav : null;
  }

  /** A cached decode opens instantly; only a miss shows the spinner. */
  async function sourceForEditing(page) {
    const entry = getSourceEntry(page);
    if (entry.canvas) return entry.canvas;
    showBusy("Opening…");
    try {
      const source = await entry.promise;
      await Detect.ensureOpenCV();
      hideBusy();
      return source;
    } catch (error) {
      hideBusy();
      alert("Couldn't open this page: " + error.message);
      return null;
    }
  }

  function applyEditorResult(page, result, source) {
    page.corners = result.corners;
    page.quarterTurns = result.quarterTurns;
    // Skip the warp entirely when nothing changed (e.g. paging through to
    // review scans); otherwise render off the critical path and persist.
    if (page.outputBlob && page.renderedSig === renderSig(page)) return;
    trackRender(regenerateOutput(page, source).then(
      () => { PageListView.refreshThumbnail(page); persist(Store.savePage(page)); },
      (error) => console.error("Rendering failed:", error)));
  }

  // ---------------------------------------------------------------
  // Page operations
  // ---------------------------------------------------------------

  function deletePage(index) {
    if (!confirm(`Delete page ${index + 1}?`)) return;
    const [page] = pages.splice(index, 1);
    forgetPage(page);
    persist(Store.removePage(page.id));
    persistPageOrder();
    renderPageList();
  }

  function movePage(from, to) {
    if (to < 0 || to >= pages.length || from === to) return;
    const [page] = pages.splice(from, 1);
    pages.splice(to, 0, page);
    persistPageOrder();
    renderPageList();
  }

  function deleteSelectedPages() {
    const selectedIds = PageListView.getSelectedPageIds();
    const selectedCount = selectedIds.size;
    if (!selectedCount) return;
    if (!confirm(`Delete ${selectedCount} page${selectedCount === 1 ? "" : "s"}?`)) return;
    for (let index = pages.length - 1; index >= 0; index--) {
      if (!selectedIds.has(pages[index].id)) continue;
      forgetPage(pages[index]);
      persist(Store.removePage(pages[index].id));
      pages.splice(index, 1);
    }
    persistPageOrder();
    PageListView.exitSelectMode();
  }

  function clearAllPages() {
    if (!pages.length) return;
    if (!confirm(`Delete all ${pages.length} pages? This can't be undone.`)) return;
    pages.forEach(forgetPage);
    pages.length = 0;
    persist(Store.clear());
    PageListView.exitSelectMode();
  }

  function discardPage(page) {
    const index = pages.indexOf(page);
    if (index >= 0) pages.splice(index, 1);
    forgetPage(page);
    renderPageList();
  }

  function releasePageURL(page) {
    if (page.outputURL) URL.revokeObjectURL(page.outputURL);
  }

  /** Releases a page for good. Distinct from releasePageURL, which
   *  regenerateOutput uses to swap a URL and must keep the render token it is
   *  currently guarding. */
  function forgetPage(page) {
    releasePageURL(page);
    renderTokens.delete(page.id);
  }

  function renderPageList() { PageListView.render(pages); }

  // ---------------------------------------------------------------
  // Compact scans (storage saver)
  // ---------------------------------------------------------------

  async function setCompactEnabled(enabled) {
    if (enabled === ScanQuality.isEnabled()) return;
    if (enabled && !confirmLossyCompression()) return;
    ScanQuality.setEnabled(enabled);
    // Turning it off only changes future scans — existing ones stay compact
    // rather than promising a restore that isn't possible.
    if (enabled && pages.length) await recompressAllPages();
  }

  function confirmLossyCompression() {
    if (!pages.length) return true;
    return confirm(
      `Compress ${pages.length} saved scan${pages.length === 1 ? "" : "s"} to save space?` +
      `\n\nThis lowers their resolution and can't be undone.`);
  }

  async function recompressAllPages() {
    showBusy("Compressing…");
    try {
      await Detect.ensureOpenCV();
      let nextDecode = pages.length ? prefetchOriginal(pages[0]) : null;
      for (let index = 0; index < pages.length; index++) {
        showBusy(`Compressing ${index + 1} / ${pages.length}…`);
        const source = await nextDecode;
        if (index + 1 < pages.length) nextDecode = prefetchOriginal(pages[index + 1]);
        await recompressPage(pages[index], source);
      }
      persistPageOrder();
    } catch (error) {
      console.error("Compression failed:", error);
      alert("Couldn't compress scans: " + error.message);
    } finally {
      hideBusy();
      renderPageList();
    }
  }

  /** Decodes the next page's original while the current one warps and encodes,
   *  the same overlap addPhotoBatch uses. Marking the rejection handled keeps a
   *  prefetch abandoned by an earlier failure quiet; awaiting it later still
   *  throws, so one unreadable page aborts the run exactly as before. */
  function prefetchOriginal(page) {
    return markRejectionHandled(
      ImageUtils.decodeImageToCanvas(page.blob, DECODE_MAX_EDGE));
  }

  async function recompressPage(page, source) {
    page.blob = await ImageUtils.encodeCanvasToJpeg(source, ScanQuality.COMPACT_ORIGINAL_QUALITY);
    await regenerateOutput(page, source);
    persist(Store.addPage(page)); // the blob changed → rewrite the full record
  }

  // ---------------------------------------------------------------
  // Rendering a page's output
  // ---------------------------------------------------------------

  const renderTokens = new Map(); // page.id -> latest render token

  /** Re-runs the render pipeline for a page and refreshes its JPEG output.
   *  Guards against a newer edit landing while this one is mid-flight. */
  async function regenerateOutput(page, sourceCanvas) {
    const token = (renderTokens.get(page.id) || 0) + 1;
    renderTokens.set(page.id, token);
    const source = sourceCanvas || (await getSource(page));
    const profile = ScanQuality.currentProfile();
    const scan = await ScanRenderer.renderScan(source, page.corners,
      { quarterTurns: page.quarterTurns, maxDim: profile.maxDim });
    if (renderTokens.get(page.id) !== token) return; // superseded by a newer edit
    const blob = await ImageUtils.encodeCanvasToJpeg(scan, profile.quality);
    if (renderTokens.get(page.id) !== token) return;
    releasePageURL(page);
    page.outputBlob = blob;
    page.outputURL = URL.createObjectURL(blob);
    page.renderedSig = renderSig(page);
  }

  /** Signature of a page's geometry — lets us skip a re-warp when nothing
   *  actually changed (e.g. paging through scans to review them). */
  function renderSig(page) {
    const { tl, tr, br, bl } = page.corners;
    return JSON.stringify([tl, tr, br, bl, page.quarterTurns]);
  }

  // Background renders in flight (page edits regenerated off the critical
  // path). Export waits on these so it never bundles a stale page.
  const inFlightRenders = new Set();

  function trackRender(render) {
    inFlightRenders.add(render);
    render.finally(() => inFlightRenders.delete(render));
    return render;
  }

  /** Loops rather than awaiting one snapshot: a render scheduled while we were
   *  waiting (session restore finishing its OpenCV load, say) must be caught
   *  too, or export bundles a page whose output is still null. */
  async function whenRendersSettle() {
    while (inFlightRenders.size) {
      await Promise.allSettled([...inFlightRenders]);
    }
  }

  // ---------------------------------------------------------------
  // Decode cache + neighbour prefetch — the slow part of opening a page is
  // decoding its full-res photo, so during an editing session we keep the
  // current page and its two neighbours decoded and ready. Bounded to 3 large
  // canvases so iOS Safari's canvas memory stays comfortable.
  // ---------------------------------------------------------------

  const sourceCache = new Map(); // page.id -> { promise, canvas|null, error|null }

  function getSourceEntry(page) {
    const cached = sourceCache.get(page.id);
    if (cached) {
      sourceCache.delete(page.id); // refresh LRU order
      sourceCache.set(page.id, cached);
      return cached;
    }
    const entry = { promise: null, canvas: null, error: null };
    entry.promise = ImageUtils.decodeImageToCanvas(page.blob, DECODE_MAX_EDGE).then(
      (canvas) => { entry.canvas = canvas; return canvas; },
      (error) => { entry.error = error; throw error; });
    markRejectionHandled(entry.promise);
    sourceCache.set(page.id, entry);
    return entry;
  }

  function getSource(page) { return getSourceEntry(page).promise; }

  /** Keeps only pages adjacent to `center` decoded; prefetches those. */
  function primeSources(center) {
    const keep = new Set();
    for (const offset of [0, 1, -1]) {
      const index = center + offset;
      if (index < 0 || index >= pages.length) continue;
      keep.add(pages[index].id);
      getSourceEntry(pages[index]);
    }
    for (const id of [...sourceCache.keys()]) {
      if (!keep.has(id)) sourceCache.delete(id); // canvas is GC'd once unreferenced
    }
  }

  function clearSourceCache() { sourceCache.clear(); }

  /** A prefetched neighbour is never awaited, so its rejection has to be
   *  marked handled or it surfaces as an unhandled promise rejection. */
  function markRejectionHandled(promise) {
    promise.catch(() => {});
    return promise;
  }

  // ---------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------

  function outputBlobs() { return pages.map((page) => page.outputBlob); }

  /** @param options { busyText, exportBlobs, failurePrefix, onDownloadFallback? } */
  async function runExport(options) {
    showBusy(options.busyText);
    try {
      await whenRendersSettle(); // never bundle a page that is still rendering
      const result = await options.exportBlobs();
      if (result.method === "download" && options.onDownloadFallback) {
        options.onDownloadFallback();
      }
    } catch (error) {
      alert(options.failurePrefix + error.message);
    } finally {
      hideBusy();
    }
  }

  // ---------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------

  /** Fire-and-forget: never let a storage hiccup break the app. */
  function persist(operation) {
    if (!Store || !Store.isAvailable) return;
    operation.catch((error) => console.warn("Persist failed:", error));
  }

  function persistPageOrder() { persist(Store.saveOrder(pages)); }

  async function restoreSavedSession() {
    if (!Store || !Store.isAvailable) return;
    let records = [];
    try {
      records = await Store.loadAll();
    } catch (error) {
      console.warn("Session restore failed:", error);
      return;
    }
    for (const record of records) {
      if (record.corners) pages.push(pageFromRecord(record));
    }
    if (pages.length) nextPageId = Math.max(...pages.map((page) => page.id)) + 1;
    rerenderPagesMissingOutput();
  }

  function pageFromRecord(record) {
    const page = {
      id: record.id,
      blob: record.blob,
      corners: record.corners,
      quarterTurns: record.quarter || 0,
      outputBlob: record.outputBlob || null,
      outputURL: record.outputBlob ? URL.createObjectURL(record.outputBlob) : null,
    };
    if (page.outputBlob) page.renderedSig = renderSig(page);
    return page;
  }

  /** Best-effort: a page whose output never got persisted (the tab was closed
   *  mid-render last visit) is re-rendered in the background. */
  function rerenderPagesMissingOutput() {
    const missing = pages.filter((page) => !page.outputBlob);
    if (!missing.length) return;
    // Tracked as ONE promise spanning the OpenCV load as well as the renders,
    // so an export during restore waits instead of seeing an empty in-flight
    // set and bundling pages that have no output yet.
    trackRender(Detect.ensureOpenCV().then(
      () => rerenderInTurn(missing),
      (error) => console.warn("Couldn't re-render restored pages:", error)));
  }

  /** One at a time on purpose: every re-render decodes a full-resolution
   *  original, so starting them all at once would hold one large canvas per
   *  restored page. The warps queue in the worker either way, so this bounds
   *  memory without costing time. A page that fails is skipped, not fatal. */
  async function rerenderInTurn(pagesToRender) {
    for (const page of pagesToRender) {
      try {
        await regenerateOutput(page);
        PageListView.refreshThumbnail(page);
        persist(Store.savePage(page));
      } catch (error) {
        console.error("Re-render failed:", error);
      }
    }
  }

  // ---------------------------------------------------------------
  // Busy / status chrome
  // ---------------------------------------------------------------

  function showBusy(text) {
    $("busyText").textContent = text;
    $("busyOverlay").hidden = false;
  }

  function hideBusy() { $("busyOverlay").hidden = true; }

  function setStatus(text) {
    const status = $("statusText");
    status.textContent = text;
    status.hidden = !text;
  }

  function showTemporaryStatus(text) {
    setStatus(text);
    setTimeout(() => setStatus(""), STATUS_MESSAGE_MS);
  }

  // Exposed for debugging/testing.
  window.Scanner = {
    pages, addFiles, startCapture, movePage,
    renderList: renderPageList, clearAll: clearAllPages,
  };
})();
