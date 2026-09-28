// bench.mjs — how fast the engine starts and how fast photos become scans,
// in headless Chromium. Not a test: the numbers are this machine's, and are
// only worth comparing before and after a change on the same machine.
//
//   npm run bench
//
// engineReadyMs    page load to OpenCV ready in both workers
// detectMs         median detection per synthetic scene, at the size a
//                  high-detail 4:3 photo is kept (2138x2850)
// batchMs          ten such photos, picked to all listed and rendered
// blockedMs        main-thread time during the batch lost to stretches of
//                  over 50 ms in which a 10 ms timer could not run — what
//                  a user would feel as the page freezing
// longestBlockMs   the longest of those stretches
import { chromium } from "@playwright/test";
import { startStaticServer } from "./helpers/static-server.mjs";

const PORT = 8125;
const PHOTO_FRAME = [2138, 2850];
const BATCH = ["plain-wood-flat", "plain-wood-tilt", "plain-dark-tilt", "form-wood", "receipt-dark",
  "carbon-wood", "blue-desk", "lamp-falloff", "a5-landscape", "strong-yaw"];

const server = await startStaticServer(new URL("../", import.meta.url).pathname, PORT);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.addScriptTag({ url: "dev/quad-tools.js" });
  await page.addScriptTag({ url: "tests/fixtures/synthetic-scenes.js" });

  const engineReadyMs = await page.evaluate(async () => {
    const started = performance.now();
    await Detect.ensureOpenCV();
    // The renderer warms alongside; a warp is what proves it ready.
    const probe = document.createElement("canvas");
    probe.width = probe.height = 64;
    await Detect.warpPerspective(probe, Detect.fullImageCorners(64, 64));
    return Math.round(performance.now() - started);
  });

  const { detectMs, files } = await page.evaluate(async ({ names, frame }) => {
    const times = [], files = [];
    for (const name of names) {
      const { canvas } = SyntheticScenes.render({ ...SyntheticScenes.SCENES.find((spec) => spec.name === name), frame });
      const started = performance.now();
      await Detect.detectCorners(canvas);
      times.push(performance.now() - started);
      files.push(new File([await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92))], `${name}.jpg`, { type: "image/jpeg" }));
    }
    window.benchFiles = files;
    times.sort((a, b) => a - b);
    return { detectMs: Math.round(times[times.length >> 1]), files: files.length };
  }, { names: BATCH, frame: PHOTO_FRAME });

  const { batchMs, blockedMs, longestBlockMs } = await page.evaluate(async () => {
    const TICK_MS = 10, BLOCK_MS = 50;
    let last = performance.now(), blockedMs = 0, longestBlockMs = 0;
    const meter = setInterval(() => {
      const now = performance.now(), gap = now - last;
      last = now;
      if (gap > BLOCK_MS) { blockedMs += gap - TICK_MS; longestBlockMs = Math.max(longestBlockMs, gap); }
    }, TICK_MS);
    const started = performance.now();
    await Scanner.addPhotos(window.benchFiles.map((file) => ({ file, viewfinderCorners: null })), 0);
    while (Scanner.pages.some((p) => !p.outputBlob)) await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(meter);
    return { batchMs: Math.round(performance.now() - started), blockedMs: Math.round(blockedMs), longestBlockMs: Math.round(longestBlockMs) };
  });

  console.log(JSON.stringify({ engineReadyMs, detectMs, photos: files, batchMs, blockedMs, longestBlockMs }));
} finally {
  await browser.close();
  server.close();
}
