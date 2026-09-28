/* synthetic-scenes.js — document photos with exactly known corners, drawn in
 * the page so no photo ever has to live in git. A sheet is modelled as a flat
 * rectangle in front of a pinhole camera: tilted, turned and moved, then
 * projected, so its perspective is one a phone could see and its true
 * proportions are known. Everything is seeded, and the print is drawn from
 * rectangles and arcs rather than fonts, so a scene renders the same on every
 * machine running the same browser.
 *
 * SyntheticScenes.render(spec) → { canvas, truth: {tl,tr,br,bl}, aspect } —
 * truth labelled by position, as the detector labels a crop, and aspect the
 * sheet's true width over height along those labels.
 * SyntheticScenes.SCENES — the detector suite: one spec per situation the
 * app meets (backgrounds, tilts, print, light, occluders, framing).
 *
 * Needs QuadTools (dev/quad-tools.js). Exposes window.SyntheticScenes.
 */
(function () {
  "use strict";

  // Width over height of the paper each spec can name.
  const PAPER_ASPECTS = { a4: 210 / 297, letter: 8.5 / 11, receipt: 80 / 210, a5landscape: 210 / 148 };
  const PAPER_COLOURS = { white: [242, 242, 238], offwhite: [232, 228, 214], carbon: [242, 212, 218], thermal: [236, 236, 234] };
  const SKIN = [214, 170, 140];
  const TEXTURE_HEIGHT = 1400; // the sheet is drawn this tall, then projected
  const FOCAL_OF_LONG_EDGE = 0.8; // a phone's main camera, roughly

  /** mulberry32: small, fast, and the same sequence everywhere. */
  function random(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    return (rand() + rand() + rand() + rand() - 2) * 1.732; // unit variance, bounded
  }

  // ---------------------------------------------------------------
  // The sheet
  // ---------------------------------------------------------------

  function drawSheet(spec, rand) {
    const height = TEXTURE_HEIGHT;
    const width = Math.round(height * PAPER_ASPECTS[spec.paper]);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const [r, g, b] = PAPER_COLOURS[spec.paperColour || "white"];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, width, height);
    const margin = Math.round(width * 0.07);
    const ink = (shade) => `rgb(${shade},${shade},${shade + 6})`;

    // A heading, then rows of words: bars of random length, the way print reads
    // at detection scale.
    ctx.fillStyle = ink(35);
    ctx.fillRect(margin, margin, width * (0.3 + 0.3 * rand()), height * 0.03);
    const rowHeight = height * 0.011, rowGap = height * 0.026;
    let y = margin + height * 0.07;
    const printEnd = spec.print === "form" ? height * 0.42 : height - margin;
    while (y < printEnd) {
      let x = margin;
      const rowEnd = width - margin - (rand() < 0.25 ? width * 0.3 * rand() : 0);
      while (x < rowEnd) {
        const word = width * (0.03 + 0.09 * rand());
        ctx.fillStyle = ink(40 + Math.round(40 * rand()));
        ctx.fillRect(x, y, Math.min(word, rowEnd - x), rowHeight);
        x += word + width * 0.015;
      }
      y += rowGap;
    }
    if (spec.print === "form") drawTable(ctx, { x: margin, y: height * 0.46, width: width - 2 * margin, height: height * 0.4 }, rand);
    if (spec.stamp) {
      ctx.strokeStyle = "rgb(60,80,170)";
      ctx.lineWidth = width * 0.008;
      ctx.beginPath();
      ctx.arc(width * 0.7, height * 0.85, width * 0.09, 0, 2 * Math.PI);
      ctx.stroke();
    }
    return canvas;
  }

  function drawTable(ctx, box, rand) {
    ctx.strokeStyle = "rgb(50,50,56)";
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    const rows = 8, columns = [0.12, 0.62, 0.8];
    for (let i = 1; i < rows; i++) {
      const y = box.y + (box.height * i) / rows;
      ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.width, y); ctx.stroke();
    }
    for (const share of columns) {
      const x = box.x + box.width * share;
      ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.height); ctx.stroke();
    }
    ctx.fillStyle = "rgb(60,60,66)";
    for (let i = 0; i < rows; i++) {
      const y = box.y + (box.height * (i + 0.4)) / rows;
      ctx.fillRect(box.x + box.width * 0.15, y, box.width * (0.2 + 0.25 * rand()), box.height * 0.03);
    }
  }

  // ---------------------------------------------------------------
  // Where the sheet lands in the photo
  // ---------------------------------------------------------------

  function rotation(pitchDeg, yawDeg, rollDeg) {
    const [a, b, c] = [pitchDeg, yawDeg, rollDeg].map((deg) => (deg * Math.PI) / 180);
    const rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
    const ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
    const rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
    const multiply = (p, q) => p.map((row) => q[0].map((_, j) => row.reduce((sum, v, k) => sum + v * q[k][j], 0)));
    return multiply(rz, multiply(ry, rx));
  }

  /** The sheet's corners in the photo, for a sheet 1 unit tall at the given
   *  pose, sized to cover `fill` of the frame and moved by `offset` (shares of
   *  the frame). */
  function projectSheet(spec, frame) {
    const aspect = PAPER_ASPECTS[spec.paper];
    const R = rotation(spec.pitch || 0, spec.yaw || 0, spec.roll || 0);
    const local = { tl: [-aspect / 2, -0.5], tr: [aspect / 2, -0.5], br: [aspect / 2, 0.5], bl: [-aspect / 2, 0.5] };
    const focal = FOCAL_OF_LONG_EDGE * Math.max(frame.width, frame.height);
    const [offsetX, offsetY] = spec.offset || [0, 0];
    const place = (distance) => {
      const shift = [offsetX * frame.width * distance / focal, offsetY * frame.height * distance / focal];
      const corners = {};
      for (const [key, [x, y]] of Object.entries(local)) {
        const X = R[0][0] * x + R[0][1] * y + shift[0];
        const Y = R[1][0] * x + R[1][1] * y + shift[1];
        const Z = R[2][0] * x + R[2][1] * y + distance;
        corners[key] = { x: frame.width / 2 + (focal * X) / Z, y: frame.height / 2 + (focal * Y) / Z };
      }
      return corners;
    };
    // Area shrinks with the square of distance: one measurement sets it.
    const probe = place(4);
    const distance = 4 * Math.sqrt(ImageUtils.quadArea(probe) / (spec.fill * frame.width * frame.height));
    return place(distance);
  }

  // ---------------------------------------------------------------
  // The photo
  // ---------------------------------------------------------------

  /** A smooth random field in 0..1, `cells` across the larger side. */
  function valueNoise(rand, width, height, cells) {
    const step = Math.max(width, height) / cells;
    const gw = Math.ceil(width / step) + 2, gh = Math.ceil(height / step) + 2;
    const grid = Array.from({ length: gw * gh }, rand);
    return (x, y) => {
      const gx = x / step, gy = y / step, ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = gx - ix, fy = gy - iy;
      const at = (i, j) => grid[j * gw + i];
      const top = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
      const bottom = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    };
  }

  function backgroundOf(kind, rand, frame) {
    const coarse = valueNoise(rand, frame.width, frame.height, 6);
    const grain = valueNoise(rand, frame.width, frame.height, 90);
    switch (kind) {
      case "wood": return (x, y) => {
        const streak = 0.5 + 0.5 * Math.sin(y * 0.045 + 6 * grain(x * 0.3, y));
        const k = 0.8 + 0.2 * streak + 0.15 * (coarse(x, y) - 0.5);
        return [150 * k, 104 * k, 66 * k];
      };
      case "dark": return (x, y) => { const v = 42 + 18 * coarse(x, y); return [v, v, v + 4]; };
      case "light": return (x, y) => { const v = 196 + 16 * coarse(x, y); return [v, v, v - 4]; };
      case "blue": return (x, y) => { const k = 0.85 + 0.25 * coarse(x, y); return [58 * k, 88 * k, 148 * k]; };
      default: throw new Error(`Unknown background ${kind}`);
    }
  }

  /** Multiplier for the light at (x, y): a fall-off across the frame, plus a
   *  soft shadow band where the spec asks for one. */
  function lightingOf(spec, frame) {
    const falloff = spec.falloff || 0;
    const band = spec.shadow;
    return (x, y) => {
      let k = 1 - falloff * (x / frame.width * 0.6 + y / frame.height * 0.4);
      if (band) {
        const d = (x * band.nx + y * band.ny) / Math.hypot(frame.width, frame.height) - band.at;
        k *= 1 - band.depth / (1 + Math.exp(-d * 60));
      }
      return k;
    };
  }

  function render(spec) {
    const rand = random(spec.seed);
    const [width, height] = spec.frame || [1500, 2000];
    const frame = { width, height };
    const sheet = drawSheet(spec, rand);
    const sheetPixels = sheet.getContext("2d").getImageData(0, 0, sheet.width, sheet.height).data;
    const truth = projectSheet(spec, frame);
    const toSheet = QuadTools.homography(
      [truth.tl, truth.tr, truth.br, truth.bl],
      [{ x: 0, y: 0 }, { x: sheet.width, y: 0 }, { x: sheet.width, y: sheet.height }, { x: 0, y: sheet.height }]);
    const background = backgroundOf(spec.background, rand, frame);
    const light = lightingOf(spec, frame);
    const noise = spec.noise === undefined ? 3 : spec.noise;

    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const image = ctx.createImageData(width, height);
    const out = image.data;
    const sw = sheet.width, sh = sheet.height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const { x: u, y: v } = toSheet({ x: x + 0.5, y: y + 0.5 });
        let rgb;
        if (u >= 0 && v >= 0 && u < sw - 1 && v < sh - 1) {
          const iu = u | 0, iv = v | 0, fu = u - iu, fv = v - iv;
          const p = (iv * sw + iu) * 4, q = p + sw * 4;
          rgb = [0, 1, 2].map((c) =>
            (sheetPixels[p + c] * (1 - fu) + sheetPixels[p + 4 + c] * fu) * (1 - fv) +
            (sheetPixels[q + c] * (1 - fu) + sheetPixels[q + 4 + c] * fu) * fv);
        } else {
          rgb = background(x, y);
        }
        const k = light(x, y);
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = rgb[c] * k + noise * gaussian(rand);
        out[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    if (spec.glare) paintGlare(ctx, spec.glare, frame);
    if (spec.occluder) paintOccluder(ctx, spec.occluder, truth);
    // The lens: nothing a camera delivers is sharper than this.
    ctx.filter = "blur(1px)";
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = "none";
    return { canvas, ...labelledByPosition(truth, PAPER_ASPECTS[spec.paper]) };
  }

  /** The truth labelled the way the detector labels a crop — tl the corner
   *  nearest the photo's top left, whichever corner of the sheet that is —
   *  and the sheet's width over height along those labels: a sheet turned a
   *  quarter shows its height as its width. */
  function labelledByPosition(corners, aspect) {
    const truth = QuadTools.canonical(corners);
    const keys = ["tl", "tr", "br", "bl"];
    const turns = keys.indexOf(keys.find((key) => corners[key] === truth.tl));
    return { truth, aspect: turns % 2 ? 1 / aspect : aspect };
  }

  /** A lamp's reflection: a bright soft spot, clipped where it saturates. */
  function paintGlare(ctx, glare, frame) {
    const cx = glare.x * frame.width, cy = glare.y * frame.height, radius = glare.radius * frame.width;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.95)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - radius, cy - radius, 2 * radius, 2 * radius);
  }

  /** A finger laid across one side of the sheet: a rounded bar from outside
   *  the sheet to a little way in. */
  function paintOccluder(ctx, occluder, truth) {
    const sides = { top: ["tl", "tr"], right: ["tr", "br"], bottom: ["br", "bl"], left: ["bl", "tl"] };
    const [a, b] = sides[occluder.side].map((key) => truth[key]);
    const at = { x: a.x + (b.x - a.x) * occluder.along, y: a.y + (b.y - a.y) * occluder.along };
    const centre = { x: (truth.tl.x + truth.br.x) / 2, y: (truth.tl.y + truth.br.y) / 2 };
    const inward = Math.atan2(centre.y - at.y, centre.x - at.x);
    const length = Math.hypot(b.x - a.x, b.y - a.y) * 0.45, thickness = length * 0.22;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(inward);
    ctx.fillStyle = `rgb(${SKIN.join(",")})`;
    ctx.beginPath();
    ctx.ellipse(-length * 0.4, 0, length * 0.75, thickness / 2, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------
  // The suite
  // ---------------------------------------------------------------

  const SHADOW_ACROSS = { nx: 0.8, ny: 0.6, at: 0.45, depth: 0.35 };

  const SCENES = [
    { name: "plain-wood-flat", paper: "a4", background: "wood", roll: 3, fill: 0.45 },
    { name: "plain-wood-tilt", paper: "a4", background: "wood", pitch: 25, yaw: 10, roll: -5, fill: 0.45 },
    { name: "plain-dark-tilt", paper: "a4", background: "dark", pitch: -20, yaw: -15, roll: 4, fill: 0.5 },
    { name: "plain-dark-steep", paper: "a4", background: "dark", pitch: 40, yaw: 5, fill: 0.4 },
    { name: "letter-wood-turned", paper: "letter", background: "wood", roll: 25, fill: 0.4 },
    { name: "form-wood", paper: "a4", print: "form", background: "wood", pitch: 15, roll: 2, fill: 0.5 },
    { name: "form-dark-shadow", paper: "a4", print: "form", background: "dark", pitch: 10, fill: 0.5, shadow: SHADOW_ACROSS },
    { name: "receipt-dark", paper: "receipt", paperColour: "thermal", background: "dark", roll: -6, fill: 0.25 },
    { name: "receipt-wood-tilt", paper: "receipt", paperColour: "thermal", background: "wood", pitch: 20, roll: 8, fill: 0.25 },
    { name: "carbon-wood", paper: "a4", paperColour: "carbon", background: "wood", pitch: 12, yaw: -8, fill: 0.45, stamp: true },
    { name: "white-on-light", paper: "a4", background: "light", pitch: 10, roll: 5, fill: 0.45 },
    { name: "blue-desk", paper: "letter", paperColour: "offwhite", background: "blue", yaw: 18, fill: 0.45 },
    { name: "lamp-falloff", paper: "a4", background: "wood", pitch: 8, fill: 0.5, falloff: 0.5 },
    { name: "finger-bottom", paper: "a4", background: "dark", pitch: 12, fill: 0.45, occluder: { side: "bottom", along: 0.6 } },
    { name: "finger-right", paper: "a4", background: "wood", yaw: -10, fill: 0.45, occluder: { side: "right", along: 0.35 } },
    { name: "small-page", paper: "a4", background: "wood", roll: 10, fill: 0.14 },
    { name: "large-page", paper: "a4", background: "dark", pitch: 5, fill: 0.72 },
    { name: "off-centre", paper: "a4", background: "wood", fill: 0.3, offset: [-0.18, -0.15], roll: -8 },
    { name: "a5-landscape", paper: "a5landscape", background: "wood", pitch: 15, fill: 0.4 },
    { name: "noisy-dark", paper: "a4", background: "dark", pitch: 18, fill: 0.45, noise: 9 },
    { name: "strong-yaw", paper: "a4", background: "wood", yaw: 35, fill: 0.4 },
    { name: "diamond", paper: "a4", background: "dark", roll: 40, fill: 0.35 },
    { name: "landscape-frame", paper: "a4", background: "wood", frame: [2000, 1500], roll: 88, fill: 0.45 },
    { name: "glare-on-page", paper: "a4", background: "wood", pitch: 10, fill: 0.5, glare: { x: 0.55, y: 0.4, radius: 0.12 } },
  ].map((spec, index) => ({ seed: 1000 + index, ...spec }));

  window.SyntheticScenes = { render, SCENES, PAPER_ASPECTS };
})();
