/* capture-ui.js — the rapid-capture screen: live preview, shutter, counter,
 * thumbnail strip and review gallery. It renders and wires DOM only — the
 * device is driven through CameraStream and the photos live in the
 * PhotoStore it is handed. Exposes window.CaptureUI.
 *
 * CaptureUI.open(store, {onFallback}) resolves with the captured shots —
 * [{ file, viewfinderCorners }], see PhotoStore.toShots — when the user taps
 * Done (or leaves via the fallback), after releasing the camera, every
 * listener and every object URL.
 */
(function () {
  "use strict";

  const FLASH_MS = 140;  // shutter flash — visual feedback only
  const STRIP_MAX = 4;   // thumbnails kept in the bottom strip
  const NOTICE_MS = 3000; // how long a one-off message stays over the viewfinder
  // Taps still waiting on their frames and encode. Each holds a full-size
  // frame, and iOS Safari draws a canvas blank once a page's canvases pass
  // its memory budget — a tap past this is ignored rather than shot black.
  const MAX_PENDING_SHOTS = 3;

  const IDS = [
    "captureView", "captureVideo", "captureOutline", "captureFlash", "captureControls",
    "shotCount", "frameInfo", "captureHint", "shotStrip", "shutterBtn", "captureDoneBtn",
    "torchBtn", "rotateBtn", "autoBtn", "macroBtn", "zoomBar",
    "captureError", "captureErrorText", "captureFallbackBtn", "captureCancelBtn",
    "galleryView", "galleryGrid", "galleryCount", "galleryEmpty", "galleryCloseBtn",
  ];

  function collectElements() {
    const els = {};
    for (const id of IDS) els[id] = document.getElementById(id);
    return els;
  }

  /** Remembers every listener so teardown can remove all of them. */
  function createBinder() {
    const bound = [];
    return {
      on(el, type, fn) { el.addEventListener(type, fn); bound.push([el, type, fn]); },
      offAll() {
        for (const [el, type, fn] of bound) el.removeEventListener(type, fn);
        bound.length = 0;
      },
    };
  }


  function open(store, opts) {
    const onFallback = (opts && opts.onFallback) || null;
    const els = collectElements();
    const camera = CameraStream.create();
    const binder = createBinder();

    return new Promise((resolve) => {
      let encodeChain = Promise.resolve(); // serialised: shots keep tap order
      let pendingShots = 0;                // tapped, not yet in the store
      let flashTimer = 0;
      let accepting = true;                // false once the session is closing
      // The camera LED, held on for the whole session. Not to be confused with
      // els.captureFlash, which is the white screen blink on each shutter tap.
      let isTorchOn = false;
      let lastView = null; // the outline's latest reading, for a tap to hand the auto shutter
      // True from opening until the camera is up, and again while a lens is
      // being swapped: the shutter, AUTO and the zoom steps all wait.
      let isLensBusy = true;
      let noticeTimer = 0;
      const zoomChips = [...els.zoomBar.querySelectorAll(".zoom-chip")];

      // Here, beside the handlers they call, which are declared in this scope.
      const outline = CaptureOutline.create(els.captureOutline, els.captureVideo,
        { onUpdate: readFrame, onLost: frameReadingEnded, view: () => camera.view() });
      const guidance = CaptureGuidance.createPresenter(renderHint);
      const autoShutter = AutoShutter.create({ onFire: shoot, onChange: renderArming });

      // ----- rendering -----

      /** The frame the camera delivers, and the size the profile keeps of it
       *  when that is smaller: "3024×4032 · 30 fps → 2850". Shown so a
       *  phone that answers a size request with a smaller frame can be seen
       *  to, rather than guessed at. */
      function describeFrame({ width, height, frameRate }) {
        if (!width || !height) return "";
        const kept = CaptureQuality.currentProfile().maxEdge;
        return `${width}×${height}${frameRate ? ` · ${Math.round(frameRate)} fps` : ""}${Math.max(width, height) > kept ? ` → ${kept}` : ""}`;
      }

      /** Shots taken, counting the ones still being encoded: a tap is a
       *  photo the moment it is made, and waiting for the encode — which
       *  queues behind every earlier tap — would leave a burst looking as
       *  though nothing had happened. A shot that fails to encode gives its
       *  count back. */
      function renderCount() {
        const taken = AppChrome.plural(store.count() + pendingShots, "photo");
        // The count lives in the pill only: a label that grows with it would
        // widen the Done button and push the shutter off centre.
        els.shotCount.textContent = taken;
        els.galleryCount.textContent = taken;
      }

      function renderStrip() {
        const recent = store.list().slice(-STRIP_MAX); // newest last, painted on top
        els.shotStrip.innerHTML = "";
        els.shotStrip.hidden = recent.length === 0;
        for (const shot of recent) els.shotStrip.appendChild(ImageUtils.thumbnailImage(shot.url));
      }

      function renderGallery() {
        els.galleryGrid.innerHTML = "";
        for (const shot of store.list()) {
          const cell = document.createElement("div");
          cell.className = "gallery-cell";
          const img = ImageUtils.thumbnailImage(shot.url);
          const del = document.createElement("button");
          del.type = "button";
          del.className = "gallery-del";
          del.dataset.shotId = String(shot.id); // read by the grid's one listener
          del.textContent = "🗑";
          del.title = "Delete photo";
          cell.append(img, del);
          els.galleryGrid.appendChild(cell);
        }
        els.galleryEmpty.hidden = store.count() > 0;
      }

      function flash() {
        els.captureFlash.hidden = false;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { els.captureFlash.hidden = true; }, FLASH_MS);
      }

      function renderHint(hint) {
        els.captureHint.textContent = hint ? hint.text : "";
        els.captureHint.hidden = !hint;
      }

      /** The shutter's ring fills while the auto shutter holds a page ready. */
      function renderArming(state) {
        els.shutterBtn.classList.toggle("is-arming", state === "steadying");
      }

      function renderAuto() {
        const isOn = AutoShutter.isEnabled();
        els.autoBtn.classList.toggle("is-on", isOn);
        els.autoBtn.setAttribute("aria-pressed", String(isOn));
        els.autoBtn.title = isOn ? "Taking a photo when the page holds still — tap to stop" : "Take a photo when the page holds still";
      }

      /** The lens and zoom as they stand. Macro is a view of its own, so with it
       *  on no zoom step is lit: the chips are for the Camera app's steps. */
      function renderLens() {
        const isMacro = CaptureLens.isMacro();
        els.macroBtn.classList.toggle("is-on", isMacro);
        els.macroBtn.setAttribute("aria-pressed", String(isMacro));
        els.macroBtn.title = isMacro ? "Close-up lens on — tap to turn it off" : "Use the close-up lens, cropped to look like 1×";
        for (const chip of zoomChips) {
          const isOn = !isMacro && Number(chip.dataset.step) === CaptureLens.step();
          chip.classList.toggle("is-on", isOn);
          chip.setAttribute("aria-pressed", String(isOn));
        }
      }

      /** Shows the zoom: the video magnified about its centre, and everything
       *  of the frame the photo will not keep hidden (CaptureLens.clipFor). */
      function renderZoomView() {
        const zoom = CaptureLens.zoom();
        const frame = ImageUtils.sourceDimensions(els.captureVideo);
        const box = { width: els.captureVideo.clientWidth, height: els.captureVideo.clientHeight };
        const clip = zoom > 1 && frame.width && box.width ? CaptureLens.clipFor(box, frame, zoom) : null;
        els.captureView.style.setProperty("--capture-zoom", String(zoom));
        els.captureView.style.setProperty("--capture-clip", clip ? `${clip.top}px ${clip.left}px` : "0px");
      }

      /** Hands the camera the zoom the settings ask for and shows it. */
      function applyZoom() {
        camera.setZoom(CaptureLens.zoom());
        renderZoomView();
      }

      /** A message over the viewfinder for a moment, in the hint's place. */
      function notice(text) {
        renderHint({ text });
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => renderHint(null), NOTICE_MS);
      }

      function showError(message) {
        els.captureErrorText.textContent = message;
        els.captureControls.hidden = true;
        els.captureError.hidden = false;
      }

      // ----- actions -----

      /** One tap: focus if the camera needs telling, keep the sharpest of the
       *  next few frames — judged where the outline says the document is —
       *  process it off the critical path, and stay on the live preview. No
       *  confirmation, no interstitial.
       *
       *  The outline is read on the tap itself, before focus and the frame
       *  burst: that is the quad the user judged when pressing, and it goes
       *  with the shot as its crop.
       *
       *  The frames are taken as soon as the tap lands, ahead of the encode
       *  chain, so a burst of taps captures a burst of moments rather than one
       *  moment per finished encode. The frame is this chain's to own, so it
       *  is released the moment the JPEG exists rather than left for the
       *  collector — each waiting frame is a full-resolution one. */
      function shoot() {
        if (!accepting) return;
        autoShutter.noteShot(lastView); // this page is taken: the auto shutter waits for the next
        flash();
        pendingShots++;
        renderCount(); // before any camera work: the tap has to read as taken
        const region = outline.region();
        const viewfinder = outline.corners();
        // Read here with the outline, not when the JPEG lands: the encode
        // finishes long after the tap, and a rotation made in between belongs
        // to the shots that follow it, not to this one.
        const quarterTurns = CaptureRotation.quarterTurns();
        const view = camera.view(); // read here too: the zoom can change before the frames come
        const frame = camera.focusOn(region)
          .then(() => CameraStream.grabSharpest(els.captureVideo, region, view));
        encodeChain = encodeChain
          .then(() => frame)
          .then((canvas) => {
            if (!canvas) { // no picture yet, or only blank ones: say so rather than lose the tap
              notice("That shot came out blank — try again");
              return;
            }
            return CameraStream.captureJpeg(canvas)
              .then((blob) => { store.add(blob, viewfinder, quarterTurns); })
              .finally(() => ImageUtils.releaseCanvas(canvas));
          })
          .catch((err) => console.error("Capture failed:", err))
          // Whether it landed or failed, this shot is no longer pending: the
          // store now speaks for it, or nothing does.
          .finally(() => {
            pendingShots--;
            renderCount();
            renderStrip();
          });
      }

      /** Every frame the outline reads: the hint over the viewfinder, and the
       *  auto shutter's cue. */
      function readFrame(view) {
        lastView = view;
        const now = performance.now();
        const hint = CaptureGuidance.hintFor(view, { available: !els.torchBtn.hidden, on: isTorchOn });
        guidance.update(hint, now);
        if (AutoShutter.isEnabled()) autoShutter.update(view, hint, now);
      }

      /** No more frames are being read — the outline was stopped, or lost
       *  its worker: nothing to advise on, and no hold to keep. */
      function frameReadingEnded() {
        lastView = null;
        guidance.clear();
        autoShutter.standDown();
      }

      function restFrameReading() {
        outline.stop();
        frameReadingEnded();
      }

      function toggleAuto() {
        AutoShutter.setEnabled(!AutoShutter.isEnabled());
        autoShutter.standDown();
        renderAuto();
      }

      // Reviewing never ends the session — the stream keeps running behind
      // the gallery, so closing it is an instant return to the live preview.
      // The outline rests while the gallery covers it: nothing to draw on.
      function openGallery() {
        restFrameReading();
        renderGallery();
        els.captureControls.hidden = true; // shutter/counter belong to the preview
        els.galleryView.hidden = false;
      }
      function closeGallery() {
        els.galleryView.hidden = true;
        els.captureControls.hidden = false;
        outline.start();
      }

      function deleteShot(id) {
        store.remove(id);
        renderCount();
        renderStrip();
        renderGallery();
      }

      /** The only exit: waits for in-flight encodes so no tap is lost. */
      function finish() {
        if (!accepting) return;
        accepting = false;
        restFrameReading(); // the session is ending; nothing more to frame
        els.shutterBtn.disabled = true;
        els.captureDoneBtn.disabled = true;
        encodeChain.then(() => {
          const shots = store.toShots(); // the files own their bytes…
          teardown();                    // …so the store can be released now
          resolve(shots);
        });
      }

      /** The viewfinder's chrome at rest: no error, no flash, the controls
       *  showing, the torch button hidden until the device admits it can. */
      function resetChrome() {
        els.macroBtn.hidden = true;
        for (const chip of zoomChips) chip.hidden = chip.dataset.step === String(CaptureLens.STEPS[0]);
        els.captureError.hidden = true;
        els.captureFlash.hidden = true;
        els.captureControls.hidden = false;
        els.captureDoneBtn.disabled = false;
        els.torchBtn.hidden = true;
        els.frameInfo.textContent = ""; // set once the camera says what it delivers
        renderHint(null);
        renderArming("searching");
        renderTorch();
        renderRotation();
        renderAuto();
        renderLens();
      }

      function teardown() {
        binder.offAll();
        restFrameReading();
        clearTimeout(flashTimer);
        clearTimeout(noticeTimer);
        els.captureView.style.removeProperty("--capture-zoom");
        els.captureView.style.removeProperty("--capture-clip");
        isTorchOn = false;
        camera.stop(els.captureVideo); // also puts the light out
        store.dispose();
        els.captureView.hidden = true;
        PageScroll.thaw(); // every exit — Done, Cancel and the fallback — lands here
        els.galleryView.hidden = true;
        resetChrome();
        els.shutterBtn.disabled = false;
        els.galleryGrid.innerHTML = "";
        els.shotStrip.innerHTML = "";
      }

      function wire() {
        wireShutterControls();
        wireLensControls();
        wireGalleryControls();
        wireFallbackControls();
        binder.on(els.torchBtn, "click", toggleTorch);
        binder.on(els.autoBtn, "click", toggleAuto);
        binder.on(els.rotateBtn, "click", () => { CaptureRotation.cycle(); renderRotation(); });
      }

      /** The glyph turns with the setting, and the button lights up whenever
       *  shots are being turned at all — the same "this is on" the torch uses. */
      function renderRotation() {
        const turns = CaptureRotation.quarterTurns();
        const description = CaptureRotation.describe();
        els.rotateBtn.querySelector(".rotate-glyph").style.transform = `rotate(${turns * 90}deg)`;
        els.rotateBtn.classList.toggle("is-on", turns !== 0);
        els.rotateBtn.title = description;
        els.rotateBtn.setAttribute("aria-label", description);
      }

      function renderTorch() {
        els.torchBtn.classList.toggle("is-on", isTorchOn);
        els.torchBtn.setAttribute("aria-pressed", String(isTorchOn));
        els.torchBtn.title = isTorchOn ? "Turn the light off" : "Turn the light on";
      }

      /** Stays on across shots for the rest of the session: the light is a
       *  track constraint, not a per-shot action. */
      function toggleTorch() {
        const wanted = !isTorchOn;
        isTorchOn = wanted;
        renderTorch();
        camera.setTorch(wanted).catch((error) => {
          console.warn("Couldn't switch the camera light:", error);
          isTorchOn = !wanted; // the device refused — don't show a state that isn't real
          renderTorch();
        });
      }

      /** Puts the open camera on `lens`. The light is a setting of the track,
       *  so a new camera is lit again if it was on. */
      async function moveToLens(lens) {
        await camera.selectLens(els.captureVideo, lens);
        if (isTorchOn && camera.supportsTorch()) {
          await camera.setTorch(true).catch((error) => console.warn("Couldn't relight the camera:", error));
        }
      }

      /** What the camera says about itself once it is running, which a new
       *  lens changes: its light, the frame it delivers, the zoomed view. */
      function showCameraState() {
        els.torchBtn.hidden = !camera.supportsTorch();
        els.frameInfo.textContent = describeFrame(camera.frameSettings());
        renderLens();
        renderZoomView();
      }

      /** Swaps the lens to the one the settings now name. Shots already tapped
       *  finish first, so no grab is cut by the swap; the shutter, AUTO and the
       *  outline rest meanwhile. A lens that will not open is put back, with
       *  the `previous` { step, macro } that named it. */
      async function switchLens(previous) {
        isLensBusy = true;
        els.shutterBtn.disabled = true;
        restFrameReading();
        try {
          await encodeChain;
          await moveToLens(CaptureLens.currentLens());
        } catch (error) {
          if (!accepting) return;
          console.warn("Couldn't switch lens:", error);
          CaptureLens.setStep(previous.step);
          CaptureLens.setMacro(previous.macro);
          applyZoom();
          try {
            await moveToLens(CaptureLens.currentLens());
            notice("That lens wouldn't open");
          } catch (restoreError) {
            console.warn("Couldn't go back to the lens before:", restoreError);
            camera.stop(els.captureVideo);
            showError(CameraStream.describeError(restoreError));
            return;
          }
        } finally {
          isLensBusy = false;
        }
        if (!accepting) return;
        els.shutterBtn.disabled = false;
        showCameraState();
        outline.start();
      }

      /** A tap on a zoom step or the Macro button: `next` is the { step, macro }
       *  it asks for. The frames being read are of the old view, so the outline
       *  starts again; the lens is swapped only when it is another one. */
      function chooseView(next) {
        const previous = { step: CaptureLens.step(), macro: CaptureLens.isMacro() };
        if (isLensBusy || !accepting || (next.step === previous.step && next.macro === previous.macro)) return;
        const previousLens = CaptureLens.currentLens();
        CaptureLens.setStep(next.step);
        CaptureLens.setMacro(next.macro);
        applyZoom();
        renderLens();
        restFrameReading();
        if (CaptureLens.currentLens() !== previousLens) switchLens(previous);
        else outline.start();
      }

      function wireLensControls() {
        binder.on(els.macroBtn, "click", () => chooseView({ step: CaptureLens.step(), macro: !CaptureLens.isMacro() }));
        // A step is its own view: it takes Macro off.
        for (const chip of zoomChips) binder.on(chip, "click", () => chooseView({ step: Number(chip.dataset.step), macro: false }));
        // The view is clipped in pixels of the box, which a turn or resize
        // moves, and of the frame, which a lens changes.
        binder.on(window, "resize", renderZoomView);
        binder.on(els.captureVideo, "resize", renderZoomView);
      }

      function wireShutterControls() {
        binder.on(els.shutterBtn, "click", () => {
          if (pendingShots < MAX_PENDING_SHOTS) shoot();
          else notice("Still saving the last photos…");
        });
        binder.on(els.captureDoneBtn, "click", finish);
      }

      function wireGalleryControls() {
        binder.on(els.shotStrip, "click", openGallery);
        binder.on(els.galleryCloseBtn, "click", closeGallery);
        // One delegated listener for every delete button, so re-rendering the
        // gallery never accumulates handlers.
        binder.on(els.galleryGrid, "click", (e) => {
          const btn = e.target.closest(".gallery-del");
          if (btn) deleteShot(Number(btn.dataset.shotId));
        });
      }

      function wireFallbackControls() {
        binder.on(els.captureFallbackBtn, "click", () => {
          // The native picker must open from this gesture, so hand over
          // before tearing the screen down.
          if (onFallback) onFallback();
          finish();
        });
        binder.on(els.captureCancelBtn, "click", finish);
      }

      // ----- start (still inside the caller's user gesture) -----

      els.captureView.hidden = false;
      // The camera covers the screen but the page behind it still scrolls,
      // which on iOS shows as the list sliding under the viewfinder.
      PageScroll.freeze();
      resetChrome();
      // The ring round the shutter fills over the auto shutter's own hold.
      els.shutterBtn.style.setProperty("--auto-hold", `${AutoShutter.HOLD_MS}ms`);
      els.shutterBtn.disabled = true; // enabled once frames are flowing
      renderCount();
      renderStrip();
      wire();
      // Both handlers check `accepting`: the user can leave before the camera
      // finishes opening, and writing to the torn-down screen would leave the
      // error panel showing when the next session opens.
      applyZoom();
      camera.start(els.captureVideo, CaptureLens.currentLens()).then(
        () => {
          if (!accepting) return;
          isLensBusy = false;
          // What needs the ultra-wide is not offered where the phone has none,
          // and a remembered choice of it falls back to the main lens, which
          // start() has pinned.
          const { hasUltraWide } = camera.lenses();
          els.macroBtn.hidden = !hasUltraWide;
          for (const chip of zoomChips) chip.hidden = !hasUltraWide && CaptureLens.lensFor(Number(chip.dataset.step)) === CaptureLens.ULTRA_WIDE;
          if (!hasUltraWide && CaptureLens.currentLens() === CaptureLens.ULTRA_WIDE) {
            CaptureLens.setMacro(false);
            CaptureLens.setStep(1);
            applyZoom();
          }
          els.shutterBtn.disabled = false;
          showCameraState();
          outline.start(); // frames are flowing now
        },
        (err) => {
          // Leaving early makes start() reject on purpose (it releases the
          // stream it was still waiting for), so that is not worth reporting.
          if (!accepting) return;
          console.warn("Camera unavailable:", err);
          showError(CameraStream.describeError(err));
        });
    });
  }

  window.CaptureUI = { open };
})();
