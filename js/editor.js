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

  /** Full pipeline: source canvas + edits → final scan canvas.
   *  opts.maxDim (optional) caps the output's longest side (Compact mode). */
  async function renderScan(sourceCanvas, corners, quarter, opts) {
    const q = ((quarter % 4) + 4) % 4;
    const map = QUARTER_MAP[q];
    const c = map
      ? { tl: corners[map.tl], tr: corners[map.tr],
          br: corners[map.br], bl: corners[map.bl] }
      : corners;
    return Detect.warpPerspective(sourceCanvas, c, opts && opts.maxDim);
  }

  // ---------------------------------------------------------------
  // Editor UI
  // ---------------------------------------------------------------

  const els = {};
  let state = null; // { source, corners, quarter, scale, resolve, seq }
  let previewTimer = null;
  let previewBusy = false;
  let previewDirty = false;
  let openSeq = 0;  // bumped each open() so a stale preview never paints

  // Each edge handle moves its two corners together along one axis.
  // `opp` maps a moving corner to the fixed corner on the far side (used to
  // stop the edge crossing past it); `sign` −1 = must stay before that corner
  // (top/left), +1 = must stay after it (bottom/right).
  const EDGE_DEF = {
    top:    { keys: ["tl", "tr"], axis: "y", opp: { tl: "bl", tr: "br" }, sign: -1 },
    bottom: { keys: ["bl", "br"], axis: "y", opp: { bl: "tl", br: "tr" }, sign: +1 },
    left:   { keys: ["tl", "bl"], axis: "x", opp: { tl: "tr", bl: "br" }, sign: -1 },
    right:  { keys: ["tr", "br"], axis: "x", opp: { tr: "tl", br: "bl" }, sign: +1 },
  };
  const EDGE_MARGIN = 8; // min source-px gap kept between opposite edges

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
    els.edgeHandles = {};
    document.querySelectorAll(".edge-handle").forEach((h) => {
      els.edgeHandles[h.dataset.edge] = h;
      attachEdgeDrag(h);
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
        seq: ++openSeq,
      };
      $("editPrevBtn").disabled = !nav.hasPrev;
      $("editNextBtn").disabled = !nav.hasNext;

      $("listView").hidden = true;
      els.view.hidden = false;
      layoutStage();
      renderPreviewNow();
    });
  }

  function close(apply, navDelta) {
    clearTimeout(previewTimer);
    // When navigating to an adjacent page the app immediately re-opens the
    // editor, so don't flip back to the list — that flashes it between pages.
    if (!(apply && navDelta)) {
      els.view.hidden = true;
      $("listView").hidden = false;
    }
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
    for (const edge in EDGE_DEF) {
      const [ka, kb] = EDGE_DEF[edge].keys;
      const a = state.corners[ka], b = state.corners[kb];
      const h = els.edgeHandles[edge];
      h.style.left = ((a.x + b.x) / 2) * s + "px";
      h.style.top = ((a.y + b.y) / 2) * s + "px";
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

  /** Clamps a rigid edge shift to the image and short of the opposite edge. */
  function clampEdgeDelta(def, start, d) {
    const max = def.axis === "x" ? state.source.width : state.source.height;
    let lo = -Infinity, hi = Infinity;
    for (const k of def.keys) {
      const v0 = start[k][def.axis];
      const opp = state.corners[def.opp[k]][def.axis];
      lo = Math.max(lo, -v0);          // stay within the image (≥ 0)
      hi = Math.min(hi, max - v0);     // stay within the image (≤ max)
      if (def.sign < 0) hi = Math.min(hi, opp - EDGE_MARGIN - v0); // before far edge
      else lo = Math.max(lo, opp + EDGE_MARGIN - v0);              // after far edge
    }
    return Math.min(Math.max(d, lo), hi);
  }

  function attachEdgeDrag(handle) {
    const def = EDGE_DEF[handle.dataset.edge];
    handle.addEventListener("pointerdown", (e) => {
      if (!state) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("active");
      els.loupe.hidden = false;
      const origin = { x: e.clientX, y: e.clientY };
      const start = {};
      for (const k of def.keys) start[k] = { x: state.corners[k].x, y: state.corners[k].y };

      const onMove = (ev) => {
        const s = state.scale;
        const raw = def.axis === "x"
          ? (ev.clientX - origin.x) / s
          : (ev.clientY - origin.y) / s;
        const d = clampEdgeDelta(def, start, raw);
        for (const k of def.keys) {
          state.corners[k] = def.axis === "x"
            ? { x: start[k].x + d, y: start[k].y }
            : { x: start[k].x, y: start[k].y + d };
        }
        positionHandles();
        const a = state.corners[def.keys[0]], b = state.corners[def.keys[1]];
        updateLoupe((a.x + b.x) / 2, (a.y + b.y) / 2);
      };
      onMove(e);

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

  /** Regenerate the preview immediately (used on open/nav — no debounce lag). */
  function renderPreviewNow() {
    clearTimeout(previewTimer);
    runPreview();
  }

  async function runPreview() {
    if (!state) return;
    if (previewBusy) { previewDirty = true; return; }
    previewBusy = true;
    const seq = state.seq;
    try {
      const { canvas: small, scale } = Detect.scaledCanvas(state.source, 500);
      const sc = (p) => ({ x: p.x * scale, y: p.y * scale });
      const corners = { tl: sc(state.corners.tl), tr: sc(state.corners.tr), br: sc(state.corners.br), bl: sc(state.corners.bl) };
      const result = await renderScan(small, corners, state.quarter);
      // A page nav (or close) may have superseded this warp while it ran.
      if (!state || state.seq !== seq) return;
      els.preview.width = result.width;
      els.preview.height = result.height;
      els.preview.getContext("2d").drawImage(result, 0, 0);
    } catch (err) {
      console.warn("Preview failed:", err);
    } finally {
      previewBusy = false;
      if (previewDirty) { previewDirty = false; if (state) schedulePreview(); }
    }
  }

  window.addEventListener("resize", () => { if (state) layoutStage(); });

  window.Editor = { init, open, renderScan };
})();
