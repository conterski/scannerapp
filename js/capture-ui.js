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

  const IDS = [
    "captureView", "captureVideo", "captureOutline", "captureFlash", "captureControls",
    "shotCount", "frameInfo", "shotStrip", "shutterBtn", "captureDoneBtn", "torchBtn",
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
    const outline = CaptureOutline.create(els.captureOutline, els.captureVideo);
    const binder = createBinder();

    return new Promise((resolve) => {
      let encodeChain = Promise.resolve(); // serialised: shots keep tap order
      let pendingShots = 0;                // tapped, not yet in the store
      let flashTimer = 0;
      let accepting = true;                // false once the session is closing
      // The camera LED, held on for the whole session. Not to be confused with
      // els.captureFlash, which is the white screen blink on each shutter tap.
      let isTorchOn = false;

      // ----- rendering -----

      /** The frame the camera delivers, and the size the profile keeps of it
       *  when that is smaller: "3840×2160 · 60 fps → 2850". Shown so a
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
        flash();
        pendingShots++;
        renderCount(); // before any camera work: the tap has to read as taken
        const region = outline.region();
        const viewfinder = outline.corners();
        const frame = camera.focusOn(region)
          .then(() => CameraStream.grabSharpest(els.captureVideo, region));
        encodeChain = encodeChain
          .then(() => frame)
          .then((canvas) => {
            if (!canvas) return; // the stream had no frame yet
            return CameraStream.captureJpeg(canvas)
              .then((blob) => { store.add(blob, viewfinder); })
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
          const shots = store.toShots(); // the files own their bytes…
          teardown();                    // …so the store can be released now
          resolve(shots);
        });
      }

      /** The viewfinder's chrome at rest: no error, no flash, the controls
       *  showing, the torch button hidden until the device admits it can. */
      function resetChrome() {
        els.captureError.hidden = true;
        els.captureFlash.hidden = true;
        els.captureControls.hidden = false;
        els.captureDoneBtn.disabled = false;
        els.torchBtn.hidden = true;
        els.frameInfo.textContent = ""; // set once the camera says what it delivers
        renderTorch();
      }

      function teardown() {
        binder.offAll();
        outline.stop();
        clearTimeout(flashTimer);
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
      resetChrome();
      els.shutterBtn.disabled = true; // enabled once frames are flowing
      renderCount();
      renderStrip();
      wire();
      // Both handlers check `accepting`: the user can leave before the camera
      // finishes opening, and writing to the torn-down screen would leave the
      // error panel showing when the next session opens.
      camera.start(els.captureVideo).then(
        () => {
          if (!accepting) return;
          els.shutterBtn.disabled = false;
          els.torchBtn.hidden = !camera.supportsTorch();
          els.frameInfo.textContent = describeFrame(camera.frameSettings());
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
