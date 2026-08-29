/* editor.js — the crop editor UI: the staged photo, its four corner handles
 * and four edge handles, the magnifier loupe, rotation controls and the live
 * preview. The warp itself lives in ScanRenderer; this file only decides which
 * corners to warp with. Exposes window.Editor.
 */
(function () {
  "use strict";

  const CORNER_KEYS = ["tl", "tr", "br", "bl"];
  const QUARTER_TURNS_PER_REVOLUTION = 4;

  // Stage layout: how much room the photo may take once the controls below it
  // have been accounted for.
  const STAGE_HORIZONTAL_MARGIN = 32;
  const STAGE_MAX_WIDTH = 688;
  const CONTROLS_RESERVED_HEIGHT = 330;
  const STAGE_MIN_HEIGHT = 240;
  const MAX_DEVICE_PIXEL_RATIO = 2; // beyond this the crispness isn't worth the memory

  const PREVIEW_MAX_EDGE = 500;
  const PREVIEW_DEBOUNCE_MS = 120;

  const LOUPE_ZOOM = 3;
  const LOUPE_BACKGROUND = "#0d0f13";
  const LOUPE_OFFSET_LEFT = 60;
  const LOUPE_OFFSET_ABOVE = 150;
  const LOUPE_OFFSET_BELOW = 40;
  const LOUPE_MIN_LEFT = -20;
  const LOUPE_RIGHT_INSET = 100;
  const LOUPE_FLIP_ABOVE_TOP = -30; // above this the loupe would leave the stage

  // Each edge handle moves its two corners together along one axis.
  // `opposite` maps a moving corner to the fixed corner on the far side (used
  // to stop the edge crossing past it); `direction` −1 = must stay before that
  // corner (top/left), +1 = must stay after it (bottom/right).
  const EDGE_DEFINITIONS = {
    top:    { corners: ["tl", "tr"], axis: "y", opposite: { tl: "bl", tr: "br" }, direction: -1 },
    bottom: { corners: ["bl", "br"], axis: "y", opposite: { bl: "tl", br: "tr" }, direction: +1 },
    left:   { corners: ["tl", "bl"], axis: "x", opposite: { tl: "tr", bl: "br" }, direction: -1 },
    right:  { corners: ["tr", "br"], axis: "x", opposite: { tr: "tl", br: "bl" }, direction: +1 },
  };
  const EDGE_MIN_GAP = 8; // source-px kept between opposite edges, so the quad can't invert

  const $ = (id) => document.getElementById(id);

  const elements = {};
  let session = null; // { source, corners, quarterTurns, scale, resolve, openId }
  let previewTimer = null;
  let isPreviewRendering = false;
  let isPreviewStale = false;
  let lastOpenId = 0; // bumped each open() so a stale preview never paints

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  function init() {
    cacheElements();
    wireHandles();
    wireControls();
    window.addEventListener("resize", () => { if (session) layoutStage(); });
  }

  /**
   * Opens the editor on one page.
   * @param source        full-res normalized canvas of the original photo
   * @param settings      { corners, quarterTurns }
   * @param navigation    { hasPrev, hasNext } — enables the ◀/▶ page buttons
   * @returns Promise<null | {corners, quarterTurns, nav}> — null on cancel;
   *          nav is -1/+1 when a page arrow closed the editor, else 0
   */
  function open(source, settings, navigation) {
    const pageNavigation = navigation || { hasPrev: false, hasNext: false };
    return new Promise((resolve) => {
      session = {
        source,
        corners: cloneCorners(settings.corners),
        quarterTurns: settings.quarterTurns || 0,
        scale: 1,
        resolve,
        openId: ++lastOpenId,
      };
      $("editPrevBtn").disabled = !pageNavigation.hasPrev;
      $("editNextBtn").disabled = !pageNavigation.hasNext;

      $("listView").hidden = true;
      elements.view.hidden = false;
      layoutStage();
      renderPreviewNow();
    });
  }

  function close(shouldApply, navDelta) {
    clearTimeout(previewTimer);
    // When navigating to an adjacent page the app immediately re-opens the
    // editor, so don't flip back to the list — that flashes it between pages.
    if (!(shouldApply && navDelta)) {
      elements.view.hidden = true;
      $("listView").hidden = false;
    }
    const resolveEditor = session.resolve;
    const result = shouldApply
      ? { corners: session.corners, quarterTurns: session.quarterTurns, nav: navDelta || 0 }
      : null;
    session = null;
    resolveEditor(result);
  }

  function cloneCorners(corners) {
    return JSON.parse(JSON.stringify(corners));
  }

  // ---------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------

  function cacheElements() {
    elements.view = $("editorView");
    elements.stage = $("editorStage");
    elements.canvas = $("editorCanvas");
    elements.overlay = $("quadOverlay");
    elements.loupe = $("loupe");
    elements.loupeCanvas = $("loupeCanvas");
    elements.preview = $("previewCanvas");
    elements.cornerHandles = {};
    elements.edgeHandles = {};
  }

  function wireHandles() {
    document.querySelectorAll(".corner-handle").forEach((handle) => {
      elements.cornerHandles[handle.dataset.corner] = handle;
      attachCornerDrag(handle);
    });
    document.querySelectorAll(".edge-handle").forEach((handle) => {
      elements.edgeHandles[handle.dataset.edge] = handle;
      attachEdgeDrag(handle);
    });
  }

  function wireControls() {
    $("rotLeftBtn").addEventListener("click", () => rotateBy(-1));
    $("rotRightBtn").addEventListener("click", () => rotateBy(+1));
    $("fullCropBtn").addEventListener("click", resetCornersToFullImage);
    $("redetectBtn").addEventListener("click", redetectCorners);
    $("cancelEditBtn").addEventListener("click", () => close(false));
    $("doneEditBtn").addEventListener("click", () => close(true));
    $("editPrevBtn").addEventListener("click", () => close(true, -1));
    $("editNextBtn").addEventListener("click", () => close(true, +1));
  }

  function rotateBy(quarterTurnDelta) {
    const turns = session.quarterTurns + quarterTurnDelta + QUARTER_TURNS_PER_REVOLUTION;
    session.quarterTurns = turns % QUARTER_TURNS_PER_REVOLUTION;
    schedulePreview();
  }

  function resetCornersToFullImage() {
    session.corners = Detect.fullImageCorners(session.source.width, session.source.height);
    positionHandles();
    schedulePreview();
  }

  async function redetectCorners() {
    session.corners = await Detect.detectCorners(session.source);
    positionHandles();
    schedulePreview();
  }

  // ---------------------------------------------------------------
  // Stage layout and overlay
  // ---------------------------------------------------------------

  /** Fits the source image into the viewport and draws it. */
  function layoutStage() {
    const source = session.source;
    const availableWidth = Math.min(window.innerWidth - STAGE_HORIZONTAL_MARGIN, STAGE_MAX_WIDTH);
    const availableHeight = Math.max(STAGE_MIN_HEIGHT, window.innerHeight - CONTROLS_RESERVED_HEIGHT);
    const scale = Math.min(availableWidth / source.width, availableHeight / source.height, 1);
    session.scale = scale;

    const stageWidth = Math.round(source.width * scale);
    const stageHeight = Math.round(source.height * scale);
    elements.stage.style.width = stageWidth + "px";
    elements.stage.style.height = stageHeight + "px";
    drawStageCanvas(stageWidth, stageHeight);
    positionHandles();
  }

  /** Draws at devicePixelRatio so the staged photo stays crisp. */
  function drawStageCanvas(stageWidth, stageHeight) {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    const canvas = elements.canvas;
    canvas.width = Math.round(stageWidth * pixelRatio);
    canvas.height = Math.round(stageHeight * pixelRatio);
    canvas.style.width = stageWidth + "px";
    canvas.style.height = stageHeight + "px";
    canvas.getContext("2d").drawImage(session.source, 0, 0, canvas.width, canvas.height);
  }

  function positionHandles() {
    const scale = session.scale;
    for (const key of CORNER_KEYS) {
      const corner = session.corners[key];
      const handle = elements.cornerHandles[key];
      handle.style.left = corner.x * scale + "px";
      handle.style.top = corner.y * scale + "px";
    }
    for (const edge in EDGE_DEFINITIONS) {
      const midpoint = edgeMidpoint(EDGE_DEFINITIONS[edge]);
      const handle = elements.edgeHandles[edge];
      handle.style.left = midpoint.x * scale + "px";
      handle.style.top = midpoint.y * scale + "px";
    }
    drawQuad();
  }

  function edgeMidpoint(definition) {
    const [first, second] = definition.corners.map((key) => session.corners[key]);
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  function drawQuad() {
    const scale = session.scale;
    const points = CORNER_KEYS
      .map((key) => session.corners[key])
      .map((corner) => `${corner.x * scale},${corner.y * scale}`)
      .join(" ");
    elements.overlay.innerHTML = `<polygon points="${points}"/>`;
  }

  // ---------------------------------------------------------------
  // Corner handles
  // ---------------------------------------------------------------

  function attachCornerDrag(handle) {
    const moveCorner = (event) => {
      const point = pointerToSource(event);
      session.corners[handle.dataset.corner] = point;
      positionHandles();
      updateLoupe(point.x, point.y);
    };
    PointerDrag.startPointerDrag(handle, {
      canStart: () => Boolean(session),
      onDragStart: (event) => { beginHandleDrag(handle); moveCorner(event); },
      onDragMove: moveCorner,
      onDragEnd: () => endHandleDrag(handle),
    });
  }

  function pointerToSource(event) {
    const bounds = elements.canvas.getBoundingClientRect();
    const scale = session.scale;
    return {
      x: clamp((event.clientX - bounds.left) / scale, 0, session.source.width),
      y: clamp((event.clientY - bounds.top) / scale, 0, session.source.height),
    };
  }

  function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }

  function beginHandleDrag(handle) {
    handle.classList.add("active");
    elements.loupe.hidden = false;
  }

  function endHandleDrag(handle) {
    handle.classList.remove("active");
    elements.loupe.hidden = true;
    schedulePreview();
  }

  // ---------------------------------------------------------------
  // Edge handles — a rigid shift of the edge's two corners along one axis
  // ---------------------------------------------------------------

  function attachEdgeDrag(handle) {
    const definition = EDGE_DEFINITIONS[handle.dataset.edge];
    let pointerOrigin = null;
    let cornersAtDragStart = null;

    const moveEdge = (event) => {
      const requestedShift = definition.axis === "x"
        ? (event.clientX - pointerOrigin.x) / session.scale
        : (event.clientY - pointerOrigin.y) / session.scale;
      applyEdgeShift(definition, cornersAtDragStart,
        clampEdgeShift(definition, cornersAtDragStart, requestedShift));
      positionHandles();
      const midpoint = edgeMidpoint(definition);
      updateLoupe(midpoint.x, midpoint.y);
    };

    PointerDrag.startPointerDrag(handle, {
      canStart: () => Boolean(session),
      onDragStart: (event) => {
        beginHandleDrag(handle);
        pointerOrigin = { x: event.clientX, y: event.clientY };
        cornersAtDragStart = {};
        for (const key of definition.corners) {
          cornersAtDragStart[key] = { x: session.corners[key].x, y: session.corners[key].y };
        }
        moveEdge(event);
      },
      onDragMove: moveEdge,
      onDragEnd: () => endHandleDrag(handle),
    });
  }

  /** Keeps a rigid edge shift inside the image and short of the opposite edge. */
  function clampEdgeShift(definition, startCorners, requestedShift) {
    const axisLimit = definition.axis === "x" ? session.source.width : session.source.height;
    let lowestShift = -Infinity;
    let highestShift = Infinity;
    for (const key of definition.corners) {
      const startValue = startCorners[key][definition.axis];
      const oppositeValue = session.corners[definition.opposite[key]][definition.axis];
      lowestShift = Math.max(lowestShift, -startValue);
      highestShift = Math.min(highestShift, axisLimit - startValue);
      if (definition.direction < 0) {
        highestShift = Math.min(highestShift, oppositeValue - EDGE_MIN_GAP - startValue);
      } else {
        lowestShift = Math.max(lowestShift, oppositeValue + EDGE_MIN_GAP - startValue);
      }
    }
    return clamp(requestedShift, lowestShift, highestShift);
  }

  function applyEdgeShift(definition, startCorners, shift) {
    for (const key of definition.corners) {
      const start = startCorners[key];
      session.corners[key] = definition.axis === "x"
        ? { x: start.x + shift, y: start.y }
        : { x: start.x, y: start.y + shift };
    }
  }

  // ---------------------------------------------------------------
  // Magnifier loupe
  // ---------------------------------------------------------------

  function updateLoupe(sourceX, sourceY) {
    drawLoupe(sourceX, sourceY);
    positionLoupe(sourceX * session.scale, sourceY * session.scale);
  }

  function drawLoupe(sourceX, sourceY) {
    const canvas = elements.loupeCanvas;
    const context = canvas.getContext("2d");
    const halfWindow = canvas.width / (2 * LOUPE_ZOOM);
    context.fillStyle = LOUPE_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(session.source,
      sourceX - halfWindow, sourceY - halfWindow, halfWindow * 2, halfWindow * 2,
      0, 0, canvas.width, canvas.height);
  }

  /** Sits above the handle, flipping below when it would leave the stage. */
  function positionLoupe(stageX, stageY) {
    const stageWidth = parseFloat(elements.stage.style.width);
    const left = clamp(stageX - LOUPE_OFFSET_LEFT, LOUPE_MIN_LEFT, stageWidth - LOUPE_RIGHT_INSET);
    const above = stageY - LOUPE_OFFSET_ABOVE;
    const top = above < LOUPE_FLIP_ABOVE_TOP ? stageY + LOUPE_OFFSET_BELOW : above;
    elements.loupe.style.left = left + "px";
    elements.loupe.style.top = top + "px";
  }

  // ---------------------------------------------------------------
  // Live preview
  // ---------------------------------------------------------------

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
  }

  /** Used on open and page nav, where the debounce would read as lag. */
  function renderPreviewNow() {
    clearTimeout(previewTimer);
    renderPreview();
  }

  async function renderPreview() {
    if (!session) return;
    if (isPreviewRendering) { isPreviewStale = true; return; }
    isPreviewRendering = true;
    const openId = session.openId;
    try {
      const scan = await renderPreviewScan();
      if (session && session.openId === openId) paintPreview(scan);
    } catch (error) {
      console.warn("Preview failed:", error);
    } finally {
      isPreviewRendering = false;
      if (isPreviewStale) {
        isPreviewStale = false;
        if (session) schedulePreview();
      }
    }
  }

  function renderPreviewScan() {
    const { canvas, scale } = ImageUtils.createScaledCanvas(session.source, PREVIEW_MAX_EDGE);
    const scaled = {};
    for (const key of CORNER_KEYS) {
      const corner = session.corners[key];
      scaled[key] = { x: corner.x * scale, y: corner.y * scale };
    }
    return ScanRenderer.renderScan(canvas, scaled, { quarterTurns: session.quarterTurns });
  }

  function paintPreview(scan) {
    elements.preview.width = scan.width;
    elements.preview.height = scan.height;
    elements.preview.getContext("2d").drawImage(scan, 0, 0);
  }

  window.Editor = { init, open };
})();
