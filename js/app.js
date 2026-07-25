/* app.js — state, photo input (EXIF-safe decode), page list UI, reordering,
 * and wiring between Detect / Editor / Exporter.
 */
(function () {
  "use strict";

  // Keep decoded images bounded so iOS Safari doesn't run out of canvas
  // memory with many 12 MP photos.
  const MAX_DIM = 2500;

  // "Compact scans" storage mode (off by default, persisted). Compact trades
  // resolution/quality for much smaller saved files: output scans render at a
  // lower cap + quality, and stored originals are re-encoded at low quality
  // (kept at full resolution so their crop coordinates stay valid).
  const OUTPUT = {
    standard: { maxDim: MAX_DIM, quality: 0.92 },
    compact:  { maxDim: 1600, quality: 0.72 },
  };
  const COMPACT_ORIGINAL_QUALITY = 0.6; // re-encode quality for stored originals
  const COMPACT_KEY = "scannerapp:compact";
  let compact = false;
  function loadCompact() { try { compact = localStorage.getItem(COMPACT_KEY) === "1"; } catch (e) {} }
  function saveCompact() { try { localStorage.setItem(COMPACT_KEY, compact ? "1" : "0"); } catch (e) {} }
  function outputProfile() { return compact ? OUTPUT.compact : OUTPUT.standard; }

  /** @type {Array<{id:number, blob:Blob, corners:Object, quarter:number,
   *  outputBlob:Blob, outputURL:string}>} */
  const pages = [];
  let nextId = 1;
  let dragSrcIndex = -1;
  const pendingShots = [];      // camera shots awaiting batch processing
  let captureThumbURL = null;   // object URL of the capture overlay thumbnail
  let selectMode = false;
  const selectedIds = new Set(); // page.id — stable across re-renders

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------
  // Image decoding (EXIF orientation applied, downscaled)
  // ---------------------------------------------------------------

  /** Decodes an image blob into a canvas ≤ MAX_DIM, EXIF orientation applied. */
  async function decodeNormalized(blob) {
    let source;
    try {
      source = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (e) {
      // Fallback: <img> decode — browsers apply EXIF orientation to <img>.
      source = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode image")); };
        img.src = url;
      });
    }
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close?.();
    return canvas;
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed"))),
        "image/jpeg", quality != null ? quality : Exporter.JPEG_QUALITY);
    });
  }

  // ---------------------------------------------------------------
  // Decode cache + neighbor prefetch — the slow part of opening a page
  // is decoding its full-res photo, so during an editing session we keep
  // the current page and its two neighbors decoded and ready. Bounded to
  // 3 large canvases so iOS Safari's canvas memory stays comfortable.
  // ---------------------------------------------------------------

  const sourceCache = new Map(); // page.id -> { promise, canvas|null, error|null }

  function getSourceEntry(page) {
    let e = sourceCache.get(page.id);
    if (e) {
      sourceCache.delete(page.id);   // refresh LRU order
      sourceCache.set(page.id, e);
      return e;
    }
    e = { promise: null, canvas: null, error: null };
    e.promise = decodeNormalized(page.blob).then(
      (cv) => { e.canvas = cv; return cv; },
      (err) => { e.error = err; throw err; });
    e.promise.catch(() => {}); // prefetched neighbors are never awaited
    sourceCache.set(page.id, e);
    return e;
  }

  function getSource(page) { return getSourceEntry(page).promise; }

  /** Keeps only pages adjacent to `center` decoded; prefetches those. */
  function primeSources(center) {
    const keep = new Set();
    for (const d of [0, 1, -1]) {
      const j = center + d;
      if (j >= 0 && j < pages.length) { keep.add(pages[j].id); getSourceEntry(pages[j]); }
    }
    for (const id of [...sourceCache.keys()]) {
      if (!keep.has(id)) sourceCache.delete(id); // canvas is GC'd once unreferenced
    }
  }

  function clearSourceCache() { sourceCache.clear(); }

  // Background renders in flight (page edits regenerated off the critical
  // path). Export waits on these so it never bundles a stale page.
  const inFlightRenders = new Set();
  function trackRender(p) {
    inFlightRenders.add(p);
    p.finally(() => inFlightRenders.delete(p));
    return p;
  }
  function whenRendersSettle() { return Promise.allSettled([...inFlightRenders]); }

  // Fire-and-forget persistence: never let a storage hiccup break the app.
  function persist(op) {
    if (Store && Store.available) op.catch((e) => console.warn("Persist failed:", e));
  }
  function persistOrder() { persist(Store.saveOrder(pages)); }

  // Signature of a page's geometry — lets us skip a re-warp when nothing
  // actually changed (e.g. paging through scans to review them).
  function renderSig(page) {
    const c = page.corners;
    return JSON.stringify([c.tl, c.tr, c.br, c.bl, page.quarter]);
  }

  // ---------------------------------------------------------------
  // Page lifecycle
  // ---------------------------------------------------------------

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || f.name);
    if (!files.length) return;
    showBusy(`Processing 1 / ${files.length}…`);
    setStatus("Loading OpenCV…");
    // Pipelined: detection in the worker is the long pole, so the next
    // photo's decode and the previous page's warp+encode run on the main
    // thread while the worker detects — their cost hides almost entirely.
    const safeDecode = (f) => decodeNormalized(f).catch((err) => err);
    const renders = [];
    try {
      await Detect.ensureOpenCV();
      setStatus("");
      let nextDecode = safeDecode(files[0]);
      for (let i = 0; i < files.length; i++) {
        showBusy(`Processing ${i + 1} / ${files.length}…`);
        const source = await nextDecode;
        if (i + 1 < files.length) nextDecode = safeDecode(files[i + 1]);
        try {
          if (source instanceof Error) throw source;
          const corners = await Detect.detectCorners(source);
          // Compact mode stores a re-encoded (smaller) original; standard keeps
          // the raw file. Resolution is unchanged either way, so the detected
          // corners stay valid against the stored blob.
          const storedBlob = compact
            ? await canvasToJpeg(source, COMPACT_ORIGINAL_QUALITY)
            : files[i];
          const page = {
            id: nextId++,
            blob: storedBlob,
            corners,
            quarter: 0,
            outputBlob: null,
            outputURL: null,
          };
          pages.push(page);
          renders.push(regenerateOutput(page, source).then(() => {
            persist(Store.addPage(page)); // blob + rendered output survive reload
            renderList();
          }, (err) => {
            console.error("Failed to render page:", err);
            const at = pages.indexOf(page);
            if (at >= 0) pages.splice(at, 1);
            renderList();
            alert(`Couldn't process "${files[i].name || "photo"}": ${err.message}`);
          }));
        } catch (err) {
          console.error("Failed to add photo:", err);
          alert(`Couldn't process "${files[i].name || "photo"}": ${err.message}`);
        }
      }
      await Promise.all(renders);
      persistOrder();
    } catch (err) {
      console.error(err);
      setStatus("");
      alert("Couldn't load the scanner engine (OpenCV). Check your connection and try again.");
    } finally {
      hideBusy();
    }
  }

  // ---------------------------------------------------------------
  // Continuous camera capture: shots pile up in pendingShots and are
  // processed as one batch when the user taps Done — detection is the
  // slow step, so it must never block between shots.
  // ---------------------------------------------------------------

  function showCaptureOverlay(lastBlob) {
    if (captureThumbURL) URL.revokeObjectURL(captureThumbURL);
    captureThumbURL = URL.createObjectURL(lastBlob);
    $("captureThumb").src = captureThumbURL;
    $("captureCount").textContent =
      `${pendingShots.length} page${pendingShots.length === 1 ? "" : "s"} captured`;
    $("captureOverlay").hidden = false;
  }

  function hideCaptureOverlay() {
    $("captureOverlay").hidden = true;
    if (captureThumbURL) {
      URL.revokeObjectURL(captureThumbURL);
      captureThumbURL = null;
    }
  }

  async function finishCapture() {
    hideCaptureOverlay();
    const shots = pendingShots.splice(0);
    if (shots.length) await addFiles(shots);
  }

  const renderSeq = new Map(); // page.id -> latest render token

  /** Re-runs the render pipeline for a page and refreshes its JPEG output.
   *  Guards against a newer edit landing while this one is mid-flight. */
  async function regenerateOutput(page, sourceCanvas) {
    const seq = (renderSeq.get(page.id) || 0) + 1;
    renderSeq.set(page.id, seq);
    const source = sourceCanvas || (await getSource(page));
    const prof = outputProfile();
    const result = await Editor.renderScan(source, page.corners, page.quarter, { maxDim: prof.maxDim });
    if (renderSeq.get(page.id) !== seq) return; // superseded by a newer edit
    const blob = await canvasToJpeg(result, prof.quality);
    if (renderSeq.get(page.id) !== seq) return;
    if (page.outputURL) URL.revokeObjectURL(page.outputURL);
    page.outputBlob = blob;
    page.outputURL = URL.createObjectURL(blob);
    page.renderedSig = renderSig(page);
  }

  async function editPage(index) {
    // The editor's ◀/▶ page arrows loop here: navigating applies the current
    // page's edits (same as Done) and opens the adjacent page. Indices are
    // stable mid-session — the list UI is hidden while the editor is open.
    //
    // Navigation is kept seamless: neighbor photos are pre-decoded, the page
    // you leave is re-rendered in the background (no blocking overlay), and
    // the next page opens instantly from cache.
    let i = index;
    $("listToolbar").hidden = true; // header actions don't apply while editing
    try {
      while (true) {
        const page = pages[i];
        primeSources(i); // decode this page + its neighbors ahead of time
        const entry = getSourceEntry(page);
        let source = entry.canvas;
        if (!source) {
          // Not decoded yet (first open or a fast miss) — wait, with a spinner.
          showBusy("Opening…");
          try {
            source = await entry.promise;
            await Detect.ensureOpenCV();
          } catch (err) {
            hideBusy();
            alert("Couldn't open this page: " + err.message);
            return;
          }
          hideBusy();
        }
        const result = await Editor.open(source, page,
          { hasPrev: i > 0, hasNext: i < pages.length - 1 });
        if (!result) return;
        page.corners = result.corners;
        page.quarter = result.quarter;
        // Skip the warp entirely when nothing changed (e.g. paging through to
        // review scans); otherwise render off the critical path and persist.
        if (!page.outputBlob || page.renderedSig !== renderSig(page)) {
          trackRender(
            regenerateOutput(page, source).then(
              () => { refreshThumb(page); persist(Store.savePage(page)); },
              (err) => console.error("Rendering failed:", err)));
        }
        if (!result.nav) return;
        i += result.nav;
      }
    } finally {
      clearSourceCache();
      renderList();
    }
  }

  /** Swaps just one page's thumbnail in place — no full grid rebuild. */
  function refreshThumb(page) {
    if (!page.outputURL) return;
    const img = $("pageGrid").querySelector(`img[data-page-id="${page.id}"]`);
    if (img) img.src = page.outputURL;
  }

  function deletePage(index) {
    const page = pages[index];
    if (!confirm(`Delete page ${index + 1}?`)) return;
    if (page.outputURL) URL.revokeObjectURL(page.outputURL);
    pages.splice(index, 1);
    persist(Store.removePage(page.id));
    persistOrder();
    renderList();
  }

  function movePage(from, to) {
    if (to < 0 || to >= pages.length || from === to) return;
    const [p] = pages.splice(from, 1);
    pages.splice(to, 0, p);
    persistOrder();
    renderList();
  }

  // ---------------------------------------------------------------
  // Select mode (bulk delete) and clear all
  // ---------------------------------------------------------------

  function enterSelectMode() {
    selectMode = true;
    selectedIds.clear();
    renderList();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds.clear();
    renderList();
  }

  function updateSelectBar() {
    const n = selectedIds.size;
    const btn = $("deleteSelectedBtn");
    btn.textContent = `Delete (${n})`;
    btn.disabled = n === 0;
  }

  function toggleSelected(page, card) {
    // Direct class toggle keeps taps instant — no re-render per selection.
    if (selectedIds.has(page.id)) {
      selectedIds.delete(page.id);
      card.classList.remove("selected");
    } else {
      selectedIds.add(page.id);
      card.classList.add("selected");
    }
    updateSelectBar();
  }

  function deleteSelected() {
    const n = selectedIds.size;
    if (!n || !confirm(`Delete ${n} page${n === 1 ? "" : "s"}?`)) return;
    for (let i = pages.length - 1; i >= 0; i--) {
      if (selectedIds.has(pages[i].id)) {
        if (pages[i].outputURL) URL.revokeObjectURL(pages[i].outputURL);
        persist(Store.removePage(pages[i].id));
        pages.splice(i, 1);
      }
    }
    persistOrder();
    exitSelectMode();
  }

  function clearAll() {
    if (!pages.length ||
        !confirm(`Delete all ${pages.length} pages? This can't be undone.`)) return;
    for (const p of pages) {
      if (p.outputURL) URL.revokeObjectURL(p.outputURL);
    }
    pages.length = 0;
    selectMode = false;
    selectedIds.clear();
    persist(Store.clear());
    renderList();
  }

  // ---------------------------------------------------------------
  // Compact scans (storage saver)
  // ---------------------------------------------------------------

  /** Switches compact mode; turning it on re-compresses existing scans. */
  async function setCompact(on) {
    if (on === compact) return;
    // Turning it on is lossy for existing scans and can't be undone — confirm.
    if (on && pages.length &&
        !confirm(`Compress ${pages.length} saved scan${pages.length === 1 ? "" : "s"} to save space?\n\nThis lowers their resolution and can't be undone.`)) {
      return;
    }
    compact = on;
    saveCompact();
    if (on && pages.length) await recompressAll();
  }

  /** Re-encodes every page's original + output at the current mode. */
  async function recompressAll() {
    showBusy("Compressing…");
    try {
      await Detect.ensureOpenCV();
      for (let idx = 0; idx < pages.length; idx++) {
        const page = pages[idx];
        showBusy(`Compressing ${idx + 1} / ${pages.length}…`);
        const source = await decodeNormalized(page.blob);
        page.blob = await canvasToJpeg(source, COMPACT_ORIGINAL_QUALITY);
        await regenerateOutput(page, source); // uses the compact profile now
        persist(Store.addPage(page)); // blob changed → rewrite the full record
      }
      persistOrder();
    } catch (err) {
      console.error("Compression failed:", err);
      alert("Couldn't compress scans: " + err.message);
    } finally {
      hideBusy();
      renderList();
    }
  }

  // ---------------------------------------------------------------
  // Page list UI
  // ---------------------------------------------------------------

  function renderList() {
    const grid = $("pageGrid");
    grid.innerHTML = "";
    $("emptyState").hidden = pages.length > 0;
    $("pdfBtn").disabled = pages.length === 0;
    $("photosBtn").disabled = pages.length === 0;
    $("listToolbar").hidden = pages.length === 0 || selectMode;
    $("addBar").hidden = selectMode;
    $("exportBar").hidden = selectMode;
    $("exportHint").hidden = selectMode;
    $("compactToggle").hidden = selectMode;
    $("selectBar").hidden = !selectMode;
    if (selectMode) updateSelectBar();

    pages.forEach((page, i) => {
      const card = document.createElement("div");
      card.className = "page-card";
      card.dataset.index = String(i);

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "page-thumb-wrap";
      const img = document.createElement("img");
      img.dataset.pageId = String(page.id);
      if (page.outputURL) img.src = page.outputURL; // render may still be in flight
      img.alt = `Page ${i + 1}`;
      img.draggable = false;
      thumbWrap.appendChild(img);

      const num = document.createElement("span");
      num.className = "page-num";
      num.textContent = String(i + 1);

      if (selectMode) {
        thumbWrap.addEventListener("click", () => toggleSelected(page, card));
        card.classList.toggle("selected", selectedIds.has(page.id));
        const badge = document.createElement("span");
        badge.className = "select-badge";
        badge.textContent = "✓";
        card.append(thumbWrap, num, badge);
        grid.appendChild(card);
        return;
      }

      thumbWrap.addEventListener("click", () => editPage(i));

      const grip = document.createElement("div");
      grip.className = "drag-grip";
      grip.textContent = "≡";
      attachDrag(grip, card);

      const actions = document.createElement("div");
      actions.className = "page-actions";
      const left = document.createElement("button");
      left.textContent = "◀";
      left.disabled = i === 0;
      left.title = "Move earlier";
      left.addEventListener("click", () => movePage(i, i - 1));
      const right = document.createElement("button");
      right.textContent = "▶";
      right.disabled = i === pages.length - 1;
      right.title = "Move later";
      right.addEventListener("click", () => movePage(i, i + 1));
      const edit = document.createElement("button");
      edit.textContent = "✂️";
      edit.title = "Adjust crop";
      edit.addEventListener("click", () => editPage(i));
      const del = document.createElement("button");
      del.className = "del-btn";
      del.textContent = "🗑";
      del.title = "Delete page";
      del.addEventListener("click", () => deletePage(i));
      actions.append(left, edit, right, del);

      card.append(thumbWrap, num, grip, actions);
      grid.appendChild(card);
    });
  }

  /** Press-drag reordering via the grip (works with touch). */
  function attachDrag(grip, card) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      dragSrcIndex = parseInt(card.dataset.index, 10);
      card.classList.add("drag-source");
      let overCard = null;

      const onMove = (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const target = el && el.closest(".page-card");
        if (overCard && overCard !== target) overCard.classList.remove("drag-over");
        overCard = target && target !== card ? target : null;
        if (overCard) overCard.classList.add("drag-over");
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        card.classList.remove("drag-source");
        if (overCard) {
          const to = parseInt(overCard.dataset.index, 10);
          overCard.classList.remove("drag-over");
          movePage(dragSrcIndex, to);
        }
        dragSrcIndex = -1;
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
  }

  // ---------------------------------------------------------------
  // Busy / status helpers
  // ---------------------------------------------------------------

  function showBusy(text) {
    $("busyText").textContent = text;
    $("busyOverlay").hidden = false;
  }
  function hideBusy() { $("busyOverlay").hidden = true; }
  function setStatus(text) {
    const el = $("statusText");
    el.textContent = text;
    el.hidden = !text;
  }

  // ---------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------

  function initInputs() {
    const fileInput = $("fileInput");
    const cameraInput = $("cameraInput");
    $("addPhotosBtn").addEventListener("click", () => fileInput.click());
    $("cameraBtn").addEventListener("click", () => cameraInput.click());
    fileInput.addEventListener("change", () => {
      addFiles(fileInput.files);
      fileInput.value = "";
    });
    cameraInput.addEventListener("change", () => {
      const file = cameraInput.files[0]; // grab ref BEFORE resetting value
      cameraInput.value = "";
      if (!file) return;
      pendingShots.push(file);
      showCaptureOverlay(file);
    });
    // Camera dismissed without a shot: keep the overlay if shots are
    // pending (Continue/Done still available), otherwise nothing to do.
    // Browsers without the cancel event just land back on the overlay,
    // which is never hidden while the camera is open.
    cameraInput.addEventListener("cancel", () => {
      if (pendingShots.length) $("captureOverlay").hidden = false;
      else hideCaptureOverlay();
    });
    $("captureMoreBtn").addEventListener("click", () => cameraInput.click());
    $("captureDoneBtn").addEventListener("click", finishCapture);

    $("selectBtn").addEventListener("click", enterSelectMode);
    $("cancelSelectBtn").addEventListener("click", exitSelectMode);
    $("deleteSelectedBtn").addEventListener("click", deleteSelected);
    $("clearAllBtn").addEventListener("click", clearAll);

    $("compactCheck").addEventListener("change", async (e) => {
      await setCompact(e.target.checked);
      e.target.checked = compact; // reflect the real state (reverts on cancel)
    });

    $("pdfBtn").addEventListener("click", async () => {
      showBusy("Building PDF…");
      try {
        await whenRendersSettle(); // don't bundle a page still rendering
        await Exporter.exportPdf(pages.map((p) => p.outputBlob));
      } catch (err) {
        alert("PDF export failed: " + err.message);
      } finally {
        hideBusy();
      }
    });

    $("photosBtn").addEventListener("click", async () => {
      showBusy("Preparing images…");
      try {
        await whenRendersSettle(); // don't bundle a page still rendering
        const res = await Exporter.exportPhotos(pages.map((p) => p.outputBlob));
        if (res.method === "download") {
          setStatus("Sharing unavailable — images downloaded in order instead.");
          setTimeout(() => setStatus(""), 6000);
        }
      } catch (err) {
        alert("Export failed: " + err.message);
      } finally {
        hideBusy();
      }
    });

    // Hide the iOS hint on platforms without file sharing.
    if (!(navigator.canShare && navigator.share)) {
      $("exportHint").textContent = "Sharing isn't available in this browser — images will download in page order instead.";
    }
  }

  // ---------------------------------------------------------------
  // Session restore — rebuild pages saved to IndexedDB on a prior visit.
  // ---------------------------------------------------------------

  async function restoreSession() {
    if (!Store || !Store.available) return;
    let saved = [];
    try {
      saved = await Store.loadAll();
    } catch (e) {
      console.warn("Session restore failed:", e);
      return;
    }
    let maxId = 0;
    for (const s of saved) {
      if (!s.corners) continue;
      const page = {
        id: s.id,
        blob: s.blob,
        corners: s.corners,
        quarter: s.quarter || 0,
        outputBlob: s.outputBlob || null,
        outputURL: s.outputBlob ? URL.createObjectURL(s.outputBlob) : null,
      };
      if (page.outputBlob) page.renderedSig = renderSig(page);
      pages.push(page);
      if (s.id > maxId) maxId = s.id;
    }
    if (pages.length) nextId = maxId + 1;

    // Best-effort: re-render any page whose output never got persisted
    // (e.g. the tab was closed mid-render on the prior visit).
    const missing = pages.filter((p) => !p.outputBlob);
    if (missing.length) {
      Detect.ensureOpenCV().then(() => {
        for (const page of missing) {
          trackRender(regenerateOutput(page).then(
            () => { refreshThumb(page); persist(Store.savePage(page)); },
            (err) => console.error("Re-render failed:", err)));
        }
      }).catch((e) => console.warn(e));
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    Editor.init();
    loadCompact();
    $("compactCheck").checked = compact;
    initInputs();
    await restoreSession(); // repopulate pages before the first paint
    renderList();
  });

  // Exposed for debugging/testing.
  window.Scanner = { pages, pendingShots, addFiles, movePage, renderList, clearAll };
})();
