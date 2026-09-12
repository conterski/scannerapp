/* app.js — orchestration: the add-photos pipeline, the editor navigation loop,
 * the capture hand-off, export wiring and session restore. Image work lives in
 * ImageUtils, quality settings in ScanQuality, the grid in PageListView, the
 * warp in ScanRenderer, persistence in Store, the busy overlay and status line
 * in AppChrome, decoded originals in SourceCache, render bookkeeping in
 * RenderTracker.
 */
(function () {
  "use strict";

  // Bounds decoded photos so iOS Safari doesn't run out of canvas memory with
  // many 12 MP originals. Standard-quality scans are capped at the same size,
  // which makes the output cap a no-op unless Compact is on.
  const DECODE_MAX_EDGE = 2500;

  // Some pickers report no MIME type at all, so an extension is the fallback.
  // A type that IS present and isn't an image must still lose.
  const IMAGE_FILE_EXTENSIONS = /\.(jpe?g|png|gif|bmp|webp|heic|heif|avif|tiff?)$/i;

  /** @type {Array<{id:number, blob:Blob, corners:Object, quarterTurns:number,
   *  outputBlob:Blob, outputURL:string, renderedSig:string}>}
   *  Stored as `quarter` on disk — Store's page record maps the name. */
  const pages = [];
  let nextPageId = 1;

  // Decoded originals for the editing session, and which renders are current
  // or still in flight. Both are bookkeeping the pipeline reads constantly and
  // neither is anyone else's business, so they are created here and passed
  // nowhere.
  const sources = SourceCache.create(
    (page) => ImageUtils.decodeImageToCanvas(page.blob, DECODE_MAX_EDGE));
  const renders = RenderTracker.create();

  // Work that walks the whole document runs one job at a time. Two passes
  // interleaved would each be reading a list the other is changing, and both
  // would be driving the same OpenCV worker.
  const libraryJobs = JobQueue.create();

  // Where the batch now being chosen should land. ASK_FOR_POSITION means the
  // user hasn't said, so addFiles raises the picker. It lives here rather than
  // travelling with the files because a file input reports back through an
  // event, long after the button that opened it.
  const ASK_FOR_POSITION = undefined;
  let pendingInsertAt = ASK_FOR_POSITION;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    // An init() that throws leaves the app half-wired: some buttons live, some
    // dead, and nothing on screen to say why. Say so instead.
    startApp().catch((error) => {
      console.error("Startup failed:", error);
      AppChrome.showTemporaryStatus("Something went wrong starting up — reload the page.");
    });
  });

  async function startApp() {
    Editor.init();
    ChoicePrompt.init();
    CaptureQuality.loadPersistedSetting();
    ScanQuality.loadPersistedSetting();
    ScanEnhance.loadPersistedSetting();
    $("highDetailCheck").checked = CaptureQuality.isEnabled();
    $("compactCheck").checked = ScanQuality.isEnabled();
    $("enhanceCheck").checked = ScanEnhance.isEnabled();
    PageListView.init({
      onEditPage: editPage,
      onDeletePage: deletePage,
      onMovePage: movePage,
      onInsertAfterPage: insertAfterPage,
      onDeleteSelected: deleteSelectedPages,
      onClearAll: clearAllPages,
      onSelectModeChanged: renderPageList,
    });
    wirePhotoInputs();
    wireOutputToggles();
    wireExportControls();
    await restoreSavedSession(); // repopulate pages before the first paint
    renderPageList();
  }

  function wirePhotoInputs() {
    const fileInput = $("fileInput");
    const cameraInput = $("cameraInput");
    $("addPhotosBtn").addEventListener("click", () => startAdd(ASK_FOR_POSITION, openLibrary));
    $("cameraBtn").addEventListener("click", () => startAdd(ASK_FOR_POSITION, openCamera));
    fileInput.addEventListener("change", () => {
      addFilesReportingFailure(fileInput.files, pendingInsertAt);
      fileInput.value = "";
    });
    // Fallback path only (no in-page camera): the system camera returns one
    // photo per trip, with its own Retake/Use Photo confirmation.
    cameraInput.addEventListener("change", () => {
      const file = cameraInput.files[0]; // grab the ref BEFORE resetting value
      cameraInput.value = "";
      if (file) addFilesReportingFailure([file], pendingInsertAt);
    });
  }

  function openLibrary() { $("fileInput").click(); }
  function openCamera() { startCapture($("cameraInput")); }

  /** Begins an add from any entry point. Setting the position here rather than
   *  clearing it afterwards is what keeps a picker the user backs out of from
   *  leaving a stale one behind: the next add overwrites it regardless. */
  function startAdd(insertAt, openSource) {
    pendingInsertAt = insertAt;
    preloadScannerEngine();
    openSource();
  }

  /** A card's + button: the position is already known, so only the source has
   *  to be asked for. The prompt hands control back inside the button's own
   *  click, which is what lets the picker open at all. */
  function insertAfterPage(index) {
    ChoicePrompt.open({
      title: `Insert after page ${index + 1}`,
      choices: [
        { label: "📷 Camera", onChoose: () => startAdd(index + 1, openCamera) },
        { label: "🖼 Photos", onChoose: () => startAdd(index + 1, openLibrary) },
      ],
    });
  }

  function wireOutputToggles() {
    // Capture resolution is fixed when a photo is taken, so unlike the other
    // two this changes new photos only and re-renders nothing.
    $("highDetailCheck").addEventListener("change", (event) => {
      CaptureQuality.setEnabled(event.target.checked);
    });
    $("compactCheck").addEventListener("change", async (event) => {
      await setCompactEnabled(event.target.checked);
      event.target.checked = ScanQuality.isEnabled(); // reverts if cancelled
    });
    $("enhanceCheck").addEventListener("change", async (event) => {
      await setNaturalFlashEnabled(event.target.checked);
      event.target.checked = ScanEnhance.isEnabled();
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
      onDownloadFallback: () => AppChrome.showTemporaryStatus(
        "Sharing unavailable — images downloaded in order instead."),
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

  /** Entry points that run inside a DOM event can't await the add, so a
   *  failure outside its own try would be an unhandled rejection with the busy
   *  overlay left up and nothing on screen to explain it. */
  function reportingFailure(adding) {
    adding.catch((error) => {
      console.error("Adding photos failed:", error);
      AppChrome.showTemporaryStatus("Couldn't add those photos.");
    });
  }

  function addFilesReportingFailure(fileList, insertAt) {
    reportingFailure(addFiles(fileList, insertAt));
  }

  /** Photos from the picker or the single-shot fallback: files alone, so the
   *  crop of each is the detector's to find. */
  function addFiles(fileList, insertAt) {
    return addPhotos(Array.from(fileList).map((file) => ({ file, viewfinderCorners: null })), insertAt);
  }

  /**
   * @param items    [{ file, viewfinderCorners }] — the outline shown when a
   *                 camera shot was taken, as fractions of the frame, becomes
   *                 that page's crop; null leaves the crop to the detector.
   * @param insertAt where the new pages go, as an index into `pages`. Omit it
   *                 to ask the user — the picker, rapid capture and the
   *                 single-shot fallback all come through here, so asking once
   *                 here covers all three. Passing it explicitly skips the
   *                 dialog, which is what the console and tests use.
   */
  async function addPhotos(items, insertAt) {
    const photos = items.filter((item) => isImageFile(item.file));
    if (!photos.length) {
      if (items.length) {
        AppChrome.showTemporaryStatus(items.length === 1
          ? "That file isn't an image — nothing was added."
          : "Those files aren't images — nothing was added.");
      }
      return;
    }
    const position = insertAt === undefined
      ? await chooseInsertPosition(photos.length)
      : insertAt;
    if (position === null) return; // cancelled — the photos are discarded
    // Only the processing queues: asking where the photos go has already
    // happened, so the dialog never waits behind another job.
    return libraryJobs.run(() => processChosenPhotos(photos, position));
  }

  async function processChosenPhotos(items, position) {
    const busy = AppChrome.beginBusy(`Processing 1 / ${items.length}…`);
    try {
      if (!(await loadScannerEngine())) return;
      const wasAppended = position === pages.length;
      const tally = await addPhotoBatch(items, position, busy);
      persistPageOrder();
      if (!wasAppended) reportInsertPosition(position);
      // Last, so it replaces the placement note: an uncropped page is the more
      // useful thing to know about.
      if (tally.detectionFailures) reportDetectionFailures(tally.detectionFailures);
    } finally {
      busy.end();
    }
  }

  /** @returns whether the engine is ready; a failure is reported here and the
   *  caller simply stops. */
  async function loadScannerEngine() {
    AppChrome.setStatus("Loading OpenCV…");
    let isReady = false;
    try {
      await Detect.ensureOpenCV();
      isReady = true;
    } catch (error) {
      console.error(error);
    }
    AppChrome.setStatus("");
    if (!isReady) {
      alert("Couldn't load the scanner engine (OpenCV). Check your connection and try again.");
    }
    return isReady;
  }

  /** Nothing to insert among on an empty list, so the dialog is skipped and
   *  the photos simply start the document. */
  function chooseInsertPosition(photoCount) {
    if (!pages.length) return Promise.resolve(0);
    return new Promise((resolve) => {
      ChoicePrompt.open({
        title: `Add ${photoCount} photo${photoCount === 1 ? "" : "s"}`,
        choices: positionChoices(resolve),
        onCancel: () => resolve(null),
      });
    });
  }

  /** One entry per slot: before the first page, after each page, and after the
   *  last — the default, so the quickest answer is the one photos have always
   *  had. */
  function positionChoices(choose) {
    const end = pages.length;
    const choices = [{ label: "At the beginning", onChoose: () => choose(0) }];
    for (let position = 1; position < end; position++) {
      choices.push({
        label: `After page ${position}`,
        onChoose: () => choose(position),
      });
    }
    choices.push({
      label: `At the end (after page ${end})`,
      onChoose: () => choose(end),
      isDefault: true,
    });
    return choices;
  }

  /** Says where the photos landed, since they aren't where the eye expects. */
  function reportInsertPosition(position) {
    AppChrome.showTemporaryStatus(position === 0
      ? "Added at the beginning — now page 1."
      : `Inserted after page ${position} — now page ${position + 1}.`);
  }

  /** Pipelined: detection in the worker is the long pole, so the next photo's
   *  decode and the previous page's warp+encode run on the main thread while
   *  the worker detects — their cost hides almost entirely. */
  async function addPhotoBatch(items, insertAt, busy) {
    const renders = [];
    // Counted rather than reported per photo: a dead worker fails every
    // remaining photo, and one message is enough to explain the whole run.
    const tally = { detectionFailures: 0 };
    // Advances only when a page is actually registered, so a photo that fails
    // to process leaves no gap in the run.
    let cursor = insertAt;
    let nextDecode = decodeOrCaptureError(items[0].file);
    for (let index = 0; index < items.length; index++) {
      busy.update(`Processing ${index + 1} / ${items.length}…`);
      const decoded = await nextDecode;
      if (index + 1 < items.length) nextDecode = decodeOrCaptureError(items[index + 1].file);
      const page = await registerPage(items[index], decoded, cursor, tally);
      if (!page) continue;
      cursor++;
      renders.push(renderAndPersistNewPage(page, decoded, items[index].file));
    }
    await Promise.all(renders);
    return tally;
  }

  /** A decode failure travels with the queue rather than rejecting it, so one
   *  unreadable photo cannot abort the whole batch. */
  function decodeOrCaptureError(file) {
    return ImageUtils.decodeImageToCanvas(file, DECODE_MAX_EDGE).catch((error) => error);
  }

  /** The outline the user framed against is the crop they expect of a camera
   *  shot; the detector, run on the saved photo, is what a shot taken with no
   *  outline showing and every library photo get. */
  async function registerPage({ file, viewfinderCorners }, decoded, index, tally) {
    try {
      if (decoded instanceof Error) throw decoded;
      const outline = viewfinderCorners && cornersAtSize(viewfinderCorners, decoded);
      const corners = outline || await detectCornersTallying(decoded, tally);
      const page = createPage(await blobToStore(file, decoded), corners, outline);
      // splice at pages.length is a push, so appending needs no special case.
      pages.splice(index, 0, page);
      return page;
    } catch (error) {
      reportPhotoFailure(file, error);
      return null;
    }
  }

  async function detectCornersTallying(decoded, tally) {
    const { corners, failed } = await Detect.detectCorners(decoded);
    if (failed) tally.detectionFailures++;
    return corners;
  }

  /** Corners given as fractions of the frame, in the pixels of `size`. The
   *  saved photo is the frame scaled uniformly, so the fractions carry over. */
  function cornersAtSize(fractions, { width, height }) {
    const corners = {};
    for (const key of Object.keys(fractions)) {
      corners[key] = { x: fractions[key].x * width, y: fractions[key].y * height };
    }
    return corners;
  }

  /** Deliberately not awaited by the batch loop: the render overlaps the next
   *  photo's detection, which is what makes the pipeline fast. */
  function renderAndPersistNewPage(page, decoded, file) {
    return regenerateOutput(page, decoded).then(() => {
      // addPage writes the original blob as well, so persisting a page that
      // has since been deleted would leave megabytes nothing ever reclaims.
      if (isPagePresent(page)) persist(Store.addPage(page));
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

  /** A render outlives the edit that started it, so by the time its output
   *  lands the page may already have been deleted. Everything that persists
   *  after an await checks this first. */
  function isPagePresent(page) { return pages.indexOf(page) >= 0; }

  /** @param viewfinderCorners the crop the viewfinder proposed, kept apart
   *                           from `corners` so the editor's Auto can return
   *                           to it after the user has dragged; null for a
   *                           photo that had no viewfinder */
  function createPage(blob, corners, viewfinderCorners) {
    return {
      id: nextPageId++,
      blob,
      corners,
      viewfinderCorners: viewfinderCorners || null,
      quarterTurns: 0,
      outputBlob: null,
      outputURL: null,
    };
  }

  /** Detection falling back to the whole image is normal; the engine failing
   *  is not, and it leaves a run of uncropped pages that otherwise looks like
   *  the app just ignored the document. */
  function reportDetectionFailures(count) {
    AppChrome.showTemporaryStatus(count === 1
      ? "Couldn't find the edges on 1 photo — crop it by hand."
      : `Couldn't find the edges on ${count} photos — crop them by hand.`);
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
    PromiseUtils.markRejectionHandled(Detect.ensureOpenCV());
  }

  /** Must be called straight from a user gesture — both getUserMedia and the
   *  native-input fallback require one. */
  function startCapture(cameraInput) {
    if (!CameraStream.isSupported()) { cameraInput.click(); return; }
    // Fixed for the whole session: a capture run lasts far longer than the tap
    // that started it, so the destination is read now rather than at Done.
    const insertAt = pendingInsertAt;
    CaptureUI.open(PhotoStore.create(), { onFallback: () => cameraInput.click() })
      .then((shots) => { if (shots.length) reportingFailure(addPhotos(shots, insertAt)); });
  }

  // ---------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------

  /** The editor's ◀/▶ arrows loop here: navigating applies the current page's
   *  edits (same as Done) and opens the adjacent page. Indices stay stable —
   *  the list is hidden while the editor is open. */
  async function editPage(startIndex) {
    // First, before anything moves: hiding the toolbar alone shortens the
    // header enough to clamp the scroll, so reading the position afterwards
    // stashes an already-clamped value and the list creeps up the page a
    // couple of pixels on every visit to the editor.
    PageScroll.remember();
    PageListView.setListChromeVisible(false); // header actions don't apply while editing
    try {
      let index = startIndex;
      while (index !== null) index = await editOnePage(index);
    } finally {
      sources.clear();
      PageListView.setListChromeVisible(true);
      renderPageList(); // the grid has to be back to full height before restoring
      PageScroll.restore();
    }
  }

  /** @returns the next index to open, or null when the session ends */
  async function editOnePage(index) {
    const page = pages[index];
    if (!page) return null;
    sources.keepAround(pages, index); // this page and its neighbours, decoded ahead
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
    const alreadyDecoded = sources.cached(page);
    if (alreadyDecoded) return alreadyDecoded;
    const busy = AppChrome.beginBusy("Opening…");
    try {
      const source = await sources.get(page);
      await Detect.ensureOpenCV();
      return source;
    } catch (error) {
      alert("Couldn't open this page: " + error.message);
      return null;
    } finally {
      busy.end();
    }
  }

  function applyEditorResult(page, result, source) {
    page.corners = result.corners;
    page.quarterTurns = result.quarterTurns;
    // Skip the warp entirely when nothing changed (e.g. paging through to
    // review scans); otherwise render off the critical path and persist.
    if (page.outputBlob && page.renderedSig === renderSig(page)) return;
    renders.track(regenerateOutput(page, source).then(
      () => {
        PageListView.refreshThumbnail(page);
        if (isPagePresent(page)) persist(Store.savePage(page));
      },
      (error) => console.error("Rendering failed:", error)));
  }

  // ---------------------------------------------------------------
  // Page operations
  // ---------------------------------------------------------------

  function deletePage(index) {
    const page = pages[index];
    if (!page) return; // splice would return [] and forgetPage would throw
    if (!confirm(`Delete page ${index + 1}?`)) return;
    pages.splice(index, 1);
    forgetPage(page);
    persist(Store.removePage(page.id));
    persistPageOrder();
    renderPageList();
  }

  function movePage(from, to) {
    // `from` as well as `to`: an out-of-range splice returns [] and would put
    // an undefined hole in `pages` that breaks render, persist and export.
    if (from < 0 || from >= pages.length) return;
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
    renders.forget(page.id);
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

  function recompressAllPages() {
    return libraryJobs.run(recompressEveryPage);
  }

  async function recompressEveryPage() {
    const busy = AppChrome.beginBusy("Compressing…");
    try {
      await Detect.ensureOpenCV();
      await forEachPageWithSource(busy, "Compressing", recompressPage);
      persistPageOrder();
    } catch (error) {
      console.error("Compression failed:", error);
      alert("Couldn't compress scans: " + error.message);
    } finally {
      busy.end();
      renderPageList();
    }
  }

  /** Walks every page in order, decoding the next original while the current
   *  one is processed — the same overlap addPhotoBatch uses. */
  async function forEachPageWithSource(busy, busyLabel, processPage) {
    // A snapshot rather than live indices: walking `pages` itself would process
    // one page twice and skip another if the list changed underneath.
    const queued = pages.slice();
    let nextDecode = queued.length ? prefetchOriginal(queued[0]) : null;
    for (let index = 0; index < queued.length; index++) {
      busy.update(`${busyLabel} ${index + 1} / ${queued.length}…`);
      const source = await nextDecode;
      // Advanced before the skip below, so a removed page never breaks the
      // decode overlap that makes the pass fast.
      if (index + 1 < queued.length) nextDecode = prefetchOriginal(queued[index + 1]);
      if (!isPagePresent(queued[index])) continue; // deleted since we started
      await processPage(queued[index], source);
    }
  }

  /** Decodes the next page's original while the current one warps and encodes,
   *  the same overlap addPhotoBatch uses. Marking the rejection handled keeps a
   *  prefetch abandoned by an earlier failure quiet; awaiting it later still
   *  throws, so one unreadable page aborts the run exactly as before. */
  function prefetchOriginal(page) {
    return PromiseUtils.markRejectionHandled(
      ImageUtils.decodeImageToCanvas(page.blob, DECODE_MAX_EDGE));
  }

  /** Turning it on or off re-renders every page, so one PDF never mixes an
   *  enhanced page with an untouched one. */
  async function setNaturalFlashEnabled(enabled) {
    if (enabled === ScanEnhance.isEnabled()) return;
    ScanEnhance.setEnabled(enabled);
    if (pages.length) await rerenderAllScans();
  }

  function rerenderAllScans() {
    return libraryJobs.run(rerenderEveryScan);
  }

  async function rerenderEveryScan() {
    const busy = AppChrome.beginBusy("Updating scans…");
    try {
      await Detect.ensureOpenCV();
      await forEachPageWithSource(busy, "Updating scans", async (page, source) => {
        await regenerateOutput(page, source);
        persist(Store.savePage(page));
      });
    } catch (error) {
      console.error("Re-rendering failed:", error);
      alert("Couldn't update the scans: " + error.message);
    } finally {
      busy.end();
      renderPageList();
    }
  }

  async function recompressPage(page, source) {
    page.blob = await ImageUtils.encodeCanvasToJpeg(source, ScanQuality.COMPACT_ORIGINAL_QUALITY);
    await regenerateOutput(page, source);
    // The blob changed → rewrite the full record, but only while the page is
    // still part of the document.
    if (isPagePresent(page)) persist(Store.addPage(page));
  }

  // ---------------------------------------------------------------
  // Rendering a page's output
  // ---------------------------------------------------------------

  /** Re-runs the render pipeline for a page and refreshes its JPEG output.
   *  Guards against a newer edit landing while this one is mid-flight. */
  async function regenerateOutput(page, sourceCanvas) {
    const isCurrent = renders.claim(page.id);
    const source = sourceCanvas || (await sources.get(page));
    const profile = ScanQuality.currentProfile();
    const scan = await ScanRenderer.renderScan(source, page.corners, {
      quarterTurns: page.quarterTurns, maxDim: profile.maxDim,
      enhance: ScanEnhance.isEnabled(),
    });
    if (!isCurrent()) return; // superseded by a newer edit
    const blob = await ImageUtils.encodeCanvasToJpeg(scan, profile.quality);
    if (!isCurrent()) return;
    releasePageURL(page);
    page.outputBlob = blob;
    page.outputURL = URL.createObjectURL(blob);
    page.renderedSig = renderSig(page);
  }

  /** Signature of everything a render depends on — lets us skip a re-warp when
   *  nothing actually changed (e.g. paging through scans to review them). */
  function renderSig(page) {
    const { tl, tr, br, bl } = page.corners;
    return JSON.stringify([tl, tr, br, bl, page.quarterTurns, ScanEnhance.isEnabled()]);
  }

  // ---------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------

  function outputBlobs() { return pages.map((page) => page.outputBlob); }

  /** Pages that have no rendered scan. Once renders have settled these are the
   *  ones that never will, so exporting them would put a hole in the file. */
  function unexportablePages() { return pages.filter((page) => !page.outputBlob); }

  function describeUnexportable(count) {
    const pageWord = count === 1 ? "page" : "pages";
    const themWord = count === 1 ? "it" : "them";
    return `${count} ${pageWord} couldn't be processed, so the export was ` +
      `cancelled.\n\nRemove ${themWord} from the list and try again.`;
  }

  /** @param options { busyText, exportBlobs, failurePrefix, onDownloadFallback? } */
  async function runExport(options) {
    const busy = AppChrome.beginBusy(options.busyText);
    try {
      await renders.whenSettled(); // never bundle a page that is still rendering
      // A page with no scan would reach the exporter as a null blob: the PDF
      // path throws, and Save to Photos silently writes a 4-byte file named
      // like a real scan. Refuse instead.
      const unexportable = unexportablePages();
      if (unexportable.length) {
        alert(describeUnexportable(unexportable.length));
        return;
      }
      const result = await options.exportBlobs();
      if (result.method === "download" && options.onDownloadFallback) {
        options.onDownloadFallback();
      }
    } catch (error) {
      alert(options.failurePrefix + error.message);
    } finally {
      busy.end();
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
      viewfinderCorners: record.viewfinderCorners || null,
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
    // Queued like the other whole-document passes: this one runs with no busy
    // overlay, so it is the one job the user really can act during.
    renders.track(libraryJobs.run(() => Detect.ensureOpenCV().then(
      () => rerenderInTurn(missing),
      (error) => console.warn("Couldn't re-render restored pages:", error))));
  }

  /** One at a time on purpose: every re-render decodes a full-resolution
   *  original, so starting them all at once would hold one large canvas per
   *  restored page. The warps queue in the worker either way, so this bounds
   *  memory without costing time. A page that fails is skipped, not fatal. */
  async function rerenderInTurn(pagesToRender) {
    for (const page of pagesToRender) {
      // Deleted while we worked: skip the decode and the warp entirely.
      if (!isPagePresent(page)) continue;
      try {
        await regenerateOutput(page);
        PageListView.refreshThumbnail(page);
        if (isPagePresent(page)) persist(Store.savePage(page));
      } catch (error) {
        // The original can't be decoded, so this page will never render. Mark
        // it so the grid shows why, and so export refuses rather than writing
        // a hole into the file.
        page.renderFailed = true;
        renderPageList();
        console.error("Re-render failed:", error);
      }
    }
  }

  // Exposed for debugging/testing.
  window.Scanner = {
    pages, addFiles, addPhotos, startCapture, movePage,
    renderList: renderPageList, clearAll: clearAllPages,
  };
})();
