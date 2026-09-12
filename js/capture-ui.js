/* capture-ui.js — the rapid-capture screen: live preview, shutter, counter,
 * thumbnail strip and review gallery. It renders and wires DOM only — the
 * device is driven through CameraStream and the photos live in the
 * PhotoStore it is handed. Exposes window.CaptureUI.
 *
 * CaptureUI.open(store, {onFallback}) resolves with the captured files when
 * the user taps Done (or leaves via the fallback), after releasing the
 * camera, every listener and every object URL.
 */
(function () {
  "use strict";

  const FLASH_MS = 140;  // shutter flash — visual feedback only
  const STRIP_MAX = 4;   // thumbnails kept in the bottom strip

  const IDS = [
    "captureView", "captureVideo", "captureOutline", "captureFlash", "captureControls",
    "shotCount", "shotStrip", "shutterBtn", "captureDoneBtn", "torchBtn",
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

  function photoLabel(n) { return `${n} photo${n === 1 ? "" : "s"}`; }

  function open(store, opts) {
    const onFallback = (opts && opts.onFallback) || null;
    const els = collectElements();
    const camera = CameraStream.create();
    const outline = CaptureOutline.create(els.captureOutline, els.captureVideo);
    const binder = createBinder();

    return new Promise((resolve) => {
      let encodeChain = Promise.resolve(); // serialised: shots keep tap order
      let flashTimer = 0;
      let accepting = true;                // false once the session is closing
      // The camera LED, held on for the whole session. Not to be confused with
      // els.captureFlash, which is the white screen blink on each shutter tap.
      let isTorchOn = false;

      // ----- rendering -----

      function renderCount() {
        const n = store.count();
        // The count lives in the pill only: a label that grows with it would
        // widen the Done button and push the shutter off centre.
        els.shotCount.textContent = photoLabel(n);
        els.galleryCount.textContent = photoLabel(n);
      }

      function renderStrip() {
        const recent = store.list().slice(-STRIP_MAX); // newest last, painted on top
        els.shotStrip.innerHTML = "";
        els.shotStrip.hidden = recent.length === 0;
        for (const shot of recent) {
          const img = document.createElement("img");
          img.src = shot.url;
          img.alt = "";
          els.shotStrip.appendChild(img);
        }
      }

      function renderGallery() {
        els.galleryGrid.innerHTML = "";
        for (const shot of store.list()) {
          const cell = document.createElement("div");
          cell.className = "gallery-cell";
          const img = document.createElement("img");
          img.src = shot.url;
          img.alt = "";
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
       *  The frames are taken as soon as the tap lands, ahead of the encode
       *  chain, so a burst of taps captures a burst of moments rather than one
       *  moment per finished encode. The frame is this chain's to own, so it
       *  is released the moment the JPEG exists rather than left for the
       *  collector — each waiting frame is a full-resolution one. */
      function shoot() {
        if (!accepting) return;
        flash();
        const region = outline.region();
        const frame = camera.focusOnce()
          .then(() => CameraStream.grabSharpest(els.captureVideo, region));
        encodeChain = encodeChain
          .then(() => frame)
          .then((canvas) => {
            if (!canvas) return; // the stream had no frame yet
            return CameraStream.captureJpeg(canvas)
              .then((blob) => {
                store.add(blob);
                renderCount();
                renderStrip();
              })
              .finally(() => ImageUtils.releaseCanvas(canvas));
          })
          .catch((err) => console.error("Capture failed:", err));
      }

      // Reviewing never ends the session — the stream keeps running behind
      // the gallery, so closing it is an instant return to the live preview.
      // The outline rests while the gallery covers it: nothing to draw on.
      function openGallery() {
        outline.stop();
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
        outline.stop(); // the session is ending; nothing more to frame
        els.shutterBtn.disabled = true;
        els.captureDoneBtn.disabled = true;
        encodeChain.then(() => {
          const files = store.toFiles(); // files own their bytes…
          teardown();                    // …so the store can be released now
          resolve(files);
        });
      }

      function teardown() {
        binder.offAll();
        outline.stop();
        clearTimeout(flashTimer);
        isTorchOn = false;
        els.torchBtn.hidden = true;
        renderTorch();
        camera.stop(els.captureVideo); // also puts the light out
        store.dispose();
        els.captureView.hidden = true;
        PageScroll.thaw(); // every exit — Done, Cancel and the fallback — lands here
        els.galleryView.hidden = true;
        els.captureError.hidden = true;
        els.captureFlash.hidden = true;
        els.captureControls.hidden = false;
        els.shutterBtn.disabled = false;
        els.captureDoneBtn.disabled = false;
        els.galleryGrid.innerHTML = "";
        els.shotStrip.innerHTML = "";
      }

      function wire() {
        wireShutterControls();
        wireGalleryControls();
        wireFallbackControls();
        binder.on(els.torchBtn, "click", toggleTorch);
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

      function wireShutterControls() {
        binder.on(els.shutterBtn, "click", shoot);
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
      els.captureError.hidden = true;
      els.captureFlash.hidden = true;
      els.captureControls.hidden = false;
      els.shutterBtn.disabled = true; // enabled once frames are flowing
      renderCount();
      renderStrip();
      wire();
      els.torchBtn.hidden = true; // shown only once the device admits it can
      renderTorch();
      // Both handlers check `accepting`: the user can leave before the camera
      // finishes opening, and writing to the torn-down screen would leave the
      // error panel showing when the next session opens.
      camera.start(els.captureVideo).then(
        () => {
          if (!accepting) return;
          els.shutterBtn.disabled = false;
          els.torchBtn.hidden = !camera.supportsTorch();
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
