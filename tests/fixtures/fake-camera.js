/* fake-camera.js — a camera for the capture screen's tests: getUserMedia
 * answered with a canvas stream of a synthetic scene, so the real capture
 * path — the outline loop, the sharpest-frame pick, the encode — runs on a
 * page whose corners are known.
 *
 * FakeCamera.install({ scene, formats }) — `scene` names a
 * SyntheticScenes spec; `formats` the frame sizes the "device" offers,
 * [width, height] in the orientation the page receives them. The format
 * nearest the request's ideal aspect ratio, then its ideal width, is the one
 * delivered — and applyConstraints picks again, as a phone would. A frame is
 * repainted every 33 ms with a pixel of jitter, so frames keep arriving and
 * no two are identical. The scene is cropped to each format, never stretched.
 *
 * Needs SyntheticScenes. Exposes window.FakeCamera.
 */
(function () {
  "use strict";

  const FRAME_INTERVAL_MS = 33;
  const JITTER_PX = 1;

  function ideal(value) {
    if (value === undefined || value === null) return undefined;
    return typeof value === "object" ? value.ideal ?? value.exact ?? value.max : value;
  }

  /** The offered format a browser would settle on for `video` constraints:
   *  closest aspect first (the long side over the short side, whichever
   *  way up), then closest width. */
  function chooseFormat(formats, video) {
    const wantWidth = ideal(video && video.width), wantHeight = ideal(video && video.height);
    const wantAspect = ideal(video && video.aspectRatio) ||
      (wantWidth && wantHeight ? Math.max(wantWidth, wantHeight) / Math.min(wantWidth, wantHeight) : undefined);
    const longSide = Math.max(wantWidth || 0, wantHeight || 0);
    const aspectOf = ([w, h]) => Math.max(w, h) / Math.min(w, h);
    const cost = (format) =>
      (wantAspect ? Math.abs(aspectOf(format) - wantAspect) / wantAspect : 0) +
      (longSide ? Math.abs(Math.max(...format) - longSide) / longSide : 0);
    return formats.reduce((best, format) => (cost(format) < cost(best) ? format : best));
  }

  function install({ scene, formats }) {
    const spec = SyntheticScenes.SCENES.find((candidate) => candidate.name === scene);
    if (!spec) throw new Error(`No synthetic scene named ${scene}`);
    const rendered = SyntheticScenes.render(spec);
    const state = { requests: [], applied: [] };

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.requests.push(constraints);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const resize = ([width, height]) => { canvas.width = width; canvas.height = height; };
      resize(chooseFormat(formats, constraints.video));
      let tick = 0;
      // Cropped to the format rather than stretched, as a sensor crops to
      // its video modes: the scene's own proportions survive every format.
      const paint = () => {
        const source = rendered.canvas;
        const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
        const dx = (canvas.width - source.width * scale) / 2 + (tick % 3 - 1) * JITTER_PX;
        const dy = (canvas.height - source.height * scale) / 2;
        tick++;
        ctx.drawImage(source, dx, dy, source.width * scale, source.height * scale);
      };
      paint();
      const timer = setInterval(paint, FRAME_INTERVAL_MS);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      track.getSettings = () => ({ width: canvas.width, height: canvas.height, frameRate: 30 });
      track.getCapabilities = () => ({});
      track.applyConstraints = async (next) => {
        state.applied.push(next);
        if (next && (next.width || next.height || next.aspectRatio)) { resize(chooseFormat(formats, next)); paint(); }
      };
      return stream;
    };
    return state;
  }

  window.FakeCamera = { install };
})();
