/* editor.js — corner-drag editor, rotation controls, and the scan render
 * pipeline (a single perspective warp; quarter rotation is folded into the
 * corner mapping). Exposes window.Editor.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Render pipeline (geometric transforms only — never any filter)
  // ---------------------------------------------------------------

  // Which source-quad corner lands at the OUTPUT's tl/tr/br/bl for each
  // clockwise quarter turn. Rotating the labels instead of the pixels makes
  // the warp itself produce the rotated scan — one resample, no extra
  // full-res canvas pass.
  const QUARTER_MAP = [
    null,
    { tl: "bl", tr: "tl", br: "tr", bl: "br" }, // 90° CW
    { tl: "br", tr: "bl", br: "tl", bl: "tr" }, // 180°
    { tl: "tr", tr: "br", br: "bl", bl: "tl" }, // 90° CCW
  ];

  /** Full pipeline: source canvas + edits → final scan canvas. */
  async function renderScan(sourceCanvas, corners, quarter) {
    const q = ((quarter % 4) + 4) % 4;
    const map = QUARTER_MAP[q];
    const c = map
      ? { tl: corners[map.tl], tr: corners[map.tr],
          br: corners[map.br], bl: corners[map.bl] }
      : corners;
    return Detect.warpPerspective(sourceCanvas, c);
  }

  // ---------------------------------------------------------------
  // Editor UI
  // ---------------------------------------------------------------

  const els = {};
  let state = null; // { source, corners, quarter, scale, resolve }
  let previewTimer = null;
  let previewBusy = false;
  let previewDirty = false;

  function $(id) { return document.getElementById(id); }

  function init() {
    els.view = $("editorView");
    els.stage = $("editorStage");
    els.canvas = $("editorCanvas");
    els.overlay = $("quadOverlay");
    els.loupe = $("loupe");
    els.loupeCanvas = $("loupeCanvas");
    els.preview = $("previewCanvas");
    els.handles = {};
    document.querySelectorAll(".corner-handle").forEach((h) => {
      els.handles[h.dataset.corner] = h;
      attachHandleDrag(h);
    });

    $("rotLeftBtn").addEventListener("click", () => { state.quarter = (state.quarter + 3) % 4; schedulePreview(); });
    $("rotRightBtn").addEventListener("click", () => { state.quarter = (state.quarter + 1) % 4; schedulePreview(); });
    $("fullCropBtn").addEventListener("click", () => {
      state.corners = Detect.fullImageCorners(state.source.width, state.source.height);
      positionHandles(); schedulePreview();
    });
    $("redetectBtn").addEventListener("click", async () => {
      state.corners = await Detect.detectCorners(state.source);
      positionHandles(); schedulePreview();
    });
    $("cancelEditBtn").addEventListener("click", () => close(false));
    $("doneEditBtn").addEventListener("click", () => close(true));
    $("editPrevBtn").addEventListener("click", () => close(true, -1));
    $("editNextBtn").addEventListener("click", () => close(true, +1));
  }

  /**
   * Opens the editor.
   * @param source   full-res normalized canvas of the original photo
   * @param settings { corners, quarter }
   * @param nav      { hasPrev, hasNext } — enables the ◀/▶ page buttons
   * @returns Promise<null | {corners, quarter, nav}> — null on cancel;
   *          nav is -1/+1 when a page arrow closed the editor, else 0
   */
  function open(source, settings, nav) {
    nav = nav || { hasPrev: false, hasNext: false };
    return new Promise((resolve) => {
      state = {
        source,
        corners: JSON.parse(JSON.stringify(settings.corners)),
        quarter: settings.quarter || 0,
        scale: 1,
        resolve,
      };
      $("editPrevBtn").disabled = !nav.hasPrev;
      $("editNextBtn").disabled = !nav.hasNext;

      $("listView").hidden = true;
      els.view.hidden = false;
      layoutStage();
      schedulePreview();
    });
  }

  function close(apply, navDelta) {
    els.view.hidden = true;
    $("listView").hidden = false;
    const r = state.resolve;
    const result = apply
      ? { corners: state.corners, quarter: state.quarter, nav: navDelta || 0 }
      : null;
    state = null;
    r(result);
  }

  /** Fits the source image into the viewport and draws it. */
  function layoutStage() {
    const src = state.source;
    const maxW = Math.min(window.innerWidth - 32, 688);
    const maxH = Math.max(240, window.innerHeight - 330);
    const scale = Math.min(maxW / src.width, maxH / src.height, 1);
    state.scale = scale;
    const cw = Math.round(src.width * scale);
    const ch = Math.round(src.height * scale);

    // Draw at devicePixelRatio for a crisp display.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    els.canvas.width = Math.round(cw * dpr);
    els.canvas.height = Math.round(ch * dpr);
    els.canvas.style.width = cw + "px";
    els.canvas.style.height = ch + "px";
    els.stage.style.width = cw + "px";
    els.stage.style.height = ch + "px";
    const ctx = els.canvas.getContext("2d");
    ctx.drawImage(src, 0, 0, els.canvas.width, els.canvas.height);
    positionHandles();
  }

  function positionHandles() {
    const s = state.scale;
    for (const key of ["tl", "tr", "br", "bl"]) {
      const p = state.corners[key];
      const h = els.handles[key];
      h.style.left = p.x * s + "px";
      h.style.top = p.y * s + "px";
    }
    drawQuad();
  }

  function drawQuad() {
    const s = state.scale;
    const c = state.corners;
    const pts = [c.tl, c.tr, c.br, c.bl]
      .map((p) => `${p.x * s},${p.y * s}`)
      .join(" ");
    els.overlay.innerHTML = `<polygon points="${pts}"/>`;
  }

  function attachHandleDrag(handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (!state) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("active");
      els.loupe.hidden = false;
      moveHandle(handle, e);

      const onMove = (ev) => moveHandle(handle, ev);
      const onUp = () => {
        handle.classList.remove("active");
        els.loupe.hidden = true;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        schedulePreview();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  function moveHandle(handle, e) {
    const rect = els.canvas.getBoundingClientRect();
    const s = state.scale;
    const x = Math.min(Math.max((e.clientX - rect.left) / s, 0), state.source.width);
    const y = Math.min(Math.max((e.clientY - rect.top) / s, 0), state.source.height);
    state.corners[handle.dataset.corner] = { x, y };
    positionHandles();
    updateLoupe(x, y);
  }

  function updateLoupe(imgX, imgY) {
    const s = state.scale;
    const lc = els.loupeCanvas;
    const ctx = lc.getContext("2d");
    const zoom = 3;
    const half = lc.width / (2 * zoom);
    ctx.fillStyle = "#0d0f13";
    ctx.fillRect(0, 0, lc.width, lc.height);
    ctx.drawImage(state.source,
      imgX - half, imgY - half, half * 2, half * 2,
      0, 0, lc.width, lc.height);

    // Place the loupe above the handle; flip below if near the top edge.
    const px = imgX * s, py = imgY * s;
    const stageW = parseFloat(els.stage.style.width);
    let lx = px - 60, ly = py - 150;
    lx = Math.min(Math.max(lx, -20), stageW - 100);
    if (ly < -30) ly = py + 40;
    els.loupe.style.left = lx + "px";
    els.loupe.style.top = ly + "px";
  }

  /** Debounced, non-overlapping preview regeneration (downscaled warp). */
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 120);
  }

  async function runPreview() {
    if (!state) return;
    if (previewBusy) { previewDirty = true; return; }
    previewBusy = true;
    try {
      const { canvas: small, scale } = Detect.scaledCanvas(state.source, 500);
      const sc = (p) => ({ x: p.x * scale, y: p.y * scale });
      const corners = { tl: sc(state.corners.tl), tr: sc(state.corners.tr), br: sc(state.corners.br), bl: sc(state.corners.bl) };
      const result = await renderScan(small, corners, state.quarter);
      if (!state) return;
      els.preview.width = result.width;
      els.preview.height = result.height;
      els.preview.getContext("2d").drawImage(result, 0, 0);
    } catch (err) {
      console.warn("Preview failed:", err);
    } finally {
      previewBusy = false;
      if (previewDirty) { previewDirty = false; schedulePreview(); }
    }
  }

  window.addEventListener("resize", () => { if (state) layoutStage(); });

  window.Editor = { init, open, renderScan };
})();
