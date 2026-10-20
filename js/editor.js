/* editor.js — the crop editor UI. A page opens on the whole photo with its
 * four corner handles, four edge handles and magnifier loupe; Apply swaps
 * that for the cropped result alone, and Edit swaps back. Rotation turns the
 * result. The warp itself lives in
 * ScanRenderer; this file only decides which corners to warp with. Exposes
 * window.Editor.
 */
(function () {
  "use strict";

  const { CORNER_KEYS, clamp, mapCorners, scaleCorners } = ImageUtils;

  // Stage layout: the photo takes the room the viewport leaves once the
  // header and the controls below have been measured, never more — the
  // editor is not meant to scroll. The floor only keeps an absurdly short
  // viewport from shrinking the stage to nothing.
  const STAGE_HORIZONTAL_MARGIN = 32;
  const STAGE_MAX_WIDTH = 688;
  const STAGE_MIN_HEIGHT = 120;
  const MAX_DEVICE_PIXEL_RATIO = 2; // beyond this the crispness isn't worth the memory

  // The cropped result is drawn from the photo scaled to this, enough for the
  // widest stage at the pixel ratio it is drawn at, and far less than the
  // photo itself: it is re-rendered on every rotation and every return from
  // Edit.
  const RESULT_MAX_EDGE = STAGE_MAX_WIDTH * MAX_DEVICE_PIXEL_RATIO;

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
  // { source, corners, quarterTurns, mode, scale, resolve, openId }; mode is
  // "edit" (the whole photo and its handles, where a page opens) or
  // "cropped" (the result alone)
  let session = null;
  let isResultRendering = false;
  let isResultStale = false;
  let lastOpenId = 0; // bumped each open() so a stale result never paints

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  function init() {
    cacheElements();
    wireHandles();
    wireControls();
    // On the next frame, once the controls have reflowed to the new width.
    window.addEventListener("resize", () => requestAnimationFrame(() => { if (session) layoutStage(); }));
  }

  /**
   * Opens the editor on one page.
   * @param source        full-res normalized canvas of the original photo
   * @param settings      { corners, viewfinderCorners, quarterTurns } — the
   *                      viewfinder's crop, when the page has one, is what
   *                      Auto returns to
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
        viewfinderCorners: settings.viewfinderCorners ? cloneCorners(settings.viewfinderCorners) : null,
        quarterTurns: settings.quarterTurns || 0,
        mode: "edit",
        scale: 1,
        resolve,
        openId: ++lastOpenId,
      };
      $("editPrevBtn").disabled = !pageNavigation.hasPrev;
      $("editNextBtn").disabled = !pageNavigation.hasNext;

      $("listView").hidden = true;
      elements.view.hidden = false;
      // The list's scroll position carries over into the shorter editor
      // document and would open it part way down. app.js has already stashed
      // it, so starting from the top here costs nothing on the way back.
      window.scrollTo(0, 0);
      // Cleared so the page before never shows when Apply brings the result up.
      elements.result.width = elements.result.height = 0;
      setMode("edit");
    });
  }

  /** Switches between the cropped result and the whole photo. The controls
   *  below the stage differ between them, so the stage is laid out again. */
  function setMode(mode) {
    session.mode = mode;
    elements.view.dataset.mode = mode;
    layoutStage();
    if (mode === "cropped") renderResult();
  }

  function close(shouldApply, navDelta) {
    // The controls are only reachable while a session is open, but a stray
    // close() used to throw on session.resolve and leave the editing loop
    // hanging — which now also strands the list's saved scroll position.
    if (!session) return;
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
    return mapCorners(corners, ({ x, y }) => ({ x, y }));
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
    elements.result = $("resultCanvas");
    elements.cornerHandles = {};
    elements.edgeHandles = {};
  }

  function wireHandles() {
    document.querySelectorAll(".corner-handle").forEach((handle) => {
      elements.cornerHandles[handle.dataset.corner] = handle;
      attachCornerDrag(handle, () => handle.dataset.corner);
    });
    // A press on the photo itself takes hold of the nearest corner.
    attachCornerDrag(elements.canvas, (event) => nearestCorner(pointerToSource(event)));
    document.querySelectorAll(".edge-handle").forEach((handle) => {
      elements.edgeHandles[handle.dataset.edge] = handle;
      attachEdgeDrag(handle);
    });
  }

  function wireControls() {
    $("rotLeftBtn").addEventListener("click", () => rotateBy(-1));
    $("rotRightBtn").addEventListener("click", () => rotateBy(+1));
    $("editCropBtn").addEventListener("click", () => setMode("edit"));
    $("applyCropBtn").addEventListener("click", () => setMode("cropped"));
    $("fullCropBtn").addEventListener("click", resetCornersToFullImage);
    $("redetectBtn").addEventListener("click", redetectCorners);
    $("cancelEditBtn").addEventListener("click", () => close(false));
    $("doneEditBtn").addEventListener("click", () => close(true));
    $("editPrevBtn").addEventListener("click", () => close(true, -1));
    $("editNextBtn").addEventListener("click", () => close(true, +1));
  }

  function isEditing() {
    return Boolean(session) && session.mode === "edit";
  }

  function rotateBy(quarterTurnDelta) {
    session.quarterTurns = ScanRenderer.normalizeQuarterTurns(session.quarterTurns + quarterTurnDelta);
    renderResult();
  }

  function resetCornersToFullImage() {
    session.corners = Detect.fullImageCorners(session.source.width, session.source.height);
    positionHandles();
  }

  /** Auto: the automatic crop. For a camera shot that is the crop the
   *  viewfinder proposed, which the user has already judged against the
   *  detector's; for anything else, the detector on the stored photo —
   *  slow enough that the editor can be closed or moved to another page
   *  before it lands, so the result is applied only to the session that
   *  asked for it, the same guard renderResult uses. */
  async function redetectCorners() {
    if (session.viewfinderCorners) {
      session.corners = cloneCorners(session.viewfinderCorners); // the handles move these; the original stays
      positionHandles();
      return;
    }
    const openId = session.openId;
    try {
      const { corners } = await Detect.detectCorners(session.source);
      if (!session || session.openId !== openId) return;
      session.corners = corners;
      positionHandles();
    } catch (error) {
      console.warn("Re-detection failed:", error);
    }
  }

  // ---------------------------------------------------------------
  // Stage layout and overlay
  // ---------------------------------------------------------------

  /** Fits the stage into the room the viewport leaves: the whole photo when
   *  editing, and, for the cropped result — whose shape is not known until it
   *  has been rendered — that whole room, with the result centred in it. */
  function layoutStage() {
    const source = session.source;
    const availableWidth = Math.min(window.innerWidth - STAGE_HORIZONTAL_MARGIN, STAGE_MAX_WIDTH);
    // Everything in the view but the stage: the header above it, the controls
    // and paddings below. The page sits at scroll 0 whenever this runs.
    const chromeHeight = elements.view.getBoundingClientRect().top + elements.view.scrollHeight - elements.stage.offsetHeight;
    const availableHeight = Math.max(STAGE_MIN_HEIGHT, Math.floor(window.innerHeight - chromeHeight));
    if (session.mode === "cropped") {
      elements.stage.style.width = availableWidth + "px";
      elements.stage.style.height = availableHeight + "px";
      return;
    }
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

  /** Drags one corner from `target`; `cornerAt(event)` names the corner the
   *  press takes hold of. */
  function attachCornerDrag(target, cornerAt) {
    let key = null;
    const moveCorner = (event) => {
      const point = pointerToSource(event);
      session.corners[key] = point;
      positionHandles();
      updateLoupe(point.x, point.y);
    };
    PointerDrag.startPointerDrag(target, {
      canStart: () => isEditing(),
      onDragStart: (event) => { key = cornerAt(event); beginHandleDrag(elements.cornerHandles[key]); moveCorner(event); },
      onDragMove: moveCorner,
      onDragEnd: () => endHandleDrag(elements.cornerHandles[key]),
    });
  }

  /** The corner nearest to a point in source pixels. */
  function nearestCorner(point) {
    const distanceTo = (key) => Math.hypot(session.corners[key].x - point.x, session.corners[key].y - point.y);
    return CORNER_KEYS.reduce((best, key) => (distanceTo(key) < distanceTo(best) ? key : best));
  }

  function pointerToSource(event) {
    const bounds = elements.canvas.getBoundingClientRect();
    const scale = session.scale;
    return {
      x: clamp((event.clientX - bounds.left) / scale, 0, session.source.width),
      y: clamp((event.clientY - bounds.top) / scale, 0, session.source.height),
    };
  }

  function beginHandleDrag(handle) {
    handle.classList.add("active");
    elements.loupe.hidden = false;
  }

  function endHandleDrag(handle) {
    handle.classList.remove("active");
    elements.loupe.hidden = true;
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
      canStart: () => isEditing(),
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
  // The cropped result
  // ---------------------------------------------------------------

  /** Draws the page as the current corners and rotation would scan it. */
  async function renderResult() {
    if (!session) return;
    if (isResultRendering) { isResultStale = true; return; }
    isResultRendering = true;
    const openId = session.openId;
    try {
      const scan = await renderResultScan();
      if (session && session.openId === openId) paintResult(scan);
      else ImageUtils.releaseCanvas(scan);
    } catch (error) {
      console.warn("Result failed:", error);
    } finally {
      isResultRendering = false;
      if (isResultStale) {
        isResultStale = false;
        if (session) renderResult();
      }
    }
  }

  function renderResultScan() {
    const { canvas, scale } = ImageUtils.createScaledCanvas(session.source, RESULT_MAX_EDGE);
    // Released on settle rather than straight away: the warp reads the canvas
    // after awaiting the worker, and a result is re-rendered on every rotation.
    return ScanRenderer.renderScan(canvas, scaleCorners(session.corners, scale), { quarterTurns: session.quarterTurns })
      .finally(() => ImageUtils.releaseCanvas(canvas));
  }

  /** Copies the scan onto the result canvas and releases it. */
  function paintResult(scan) {
    elements.result.width = scan.width;
    elements.result.height = scan.height;
    elements.result.getContext("2d").drawImage(scan, 0, 0);
    ImageUtils.releaseCanvas(scan);
  }

  window.Editor = { init, open };
})();
