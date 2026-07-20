/* app.js — state, photo input (EXIF-safe decode), page list UI, reordering,
 * and wiring between Detect / Editor / Exporter.
 */
(function () {
  "use strict";

  // Keep decoded images bounded so iOS Safari doesn't run out of canvas
  // memory with many 12 MP photos.
  const MAX_DIM = 2500;

  /** @type {Array<{id:number, blob:Blob, corners:Object, quarter:number,
   *  fineAngle:number, outputBlob:Blob, outputURL:string}>} */
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

  function canvasToJpeg(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed"))),
        "image/jpeg", Exporter.JPEG_QUALITY);
    });
  }

  // ---------------------------------------------------------------
  // Page lifecycle
  // ---------------------------------------------------------------

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || f.name);
    if (!files.length) return;
    showBusy(`Processing 1 / ${files.length}…`);
    setStatus("Loading OpenCV…");
    try {
      await Detect.ensureOpenCV();
      setStatus("");
      for (let i = 0; i < files.length; i++) {
        showBusy(`Processing ${i + 1} / ${files.length}…`);
        try {
          const source = await decodeNormalized(files[i]);
          const corners = await Detect.detectCorners(source);
          const page = {
            id: nextId++,
            blob: files[i],
            corners,
            quarter: 0,
            fineAngle: 0,
            outputBlob: null,
            outputURL: null,
          };
          await regenerateOutput(page, source);
          pages.push(page);
          renderList();
        } catch (err) {
          console.error("Failed to add photo:", err);
          alert(`Couldn't process "${files[i].name || "photo"}": ${err.message}`);
        }
      }
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

  /** Re-runs the render pipeline for a page and refreshes its JPEG output. */
  async function regenerateOutput(page, sourceCanvas) {
    const source = sourceCanvas || (await decodeNormalized(page.blob));
    const result = await Editor.renderScan(source, page.corners, page.quarter, page.fineAngle);
    const blob = await canvasToJpeg(result);
    if (page.outputURL) URL.revokeObjectURL(page.outputURL);
    page.outputBlob = blob;
    page.outputURL = URL.createObjectURL(blob);
  }

  async function editPage(index) {
    // The editor's ◀/▶ page arrows loop here: navigating applies the current
    // page's edits (same as Done) and opens the adjacent page. Indices are
    // stable mid-session — the list UI is hidden while the editor is open.
    let i = index;
    try {
      while (true) {
        const page = pages[i];
        showBusy("Opening editor…");
        let source;
        try {
          source = await decodeNormalized(page.blob);
          await Detect.ensureOpenCV();
        } catch (err) {
          hideBusy();
          alert("Couldn't open this page: " + err.message);
          return;
        }
        hideBusy();
        const result = await Editor.open(source, page,
          { hasPrev: i > 0, hasNext: i < pages.length - 1 });
        if (!result) return;
        page.corners = result.corners;
        page.quarter = result.quarter;
        page.fineAngle = result.fineAngle;
        showBusy("Rendering…");
        try {
          await regenerateOutput(page, source);
        } catch (err) {
          alert("Rendering failed: " + err.message);
        } finally {
          hideBusy();
        }
        if (!result.nav) return;
        i += result.nav;
      }
    } finally {
      renderList();
    }
  }

  function deletePage(index) {
    const page = pages[index];
    if (!confirm(`Delete page ${index + 1}?`)) return;
    if (page.outputURL) URL.revokeObjectURL(page.outputURL);
    pages.splice(index, 1);
    renderList();
  }

  function movePage(from, to) {
    if (to < 0 || to >= pages.length || from === to) return;
    const [p] = pages.splice(from, 1);
    pages.splice(to, 0, p);
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
        pages.splice(i, 1);
      }
    }
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
    renderList();
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
    $("selectBar").hidden = !selectMode;
    if (selectMode) updateSelectBar();

    pages.forEach((page, i) => {
      const card = document.createElement("div");
      card.className = "page-card";
      card.dataset.index = String(i);

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "page-thumb-wrap";
      const img = document.createElement("img");
      img.src = page.outputURL;
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

    $("pdfBtn").addEventListener("click", async () => {
      showBusy("Building PDF…");
      try {
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

  document.addEventListener("DOMContentLoaded", () => {
    Editor.init();
    initInputs();
    renderList();
  });

  // Exposed for debugging/testing.
  window.Scanner = { pages, pendingShots, addFiles, movePage, renderList, clearAll };
})();
