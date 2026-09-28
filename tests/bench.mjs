// bench.mjs — how fast the engine starts and how fast photos become scans,
// in headless Chromium. Not a test: the numbers are this machine's, and are
// only worth comparing before and after a change on the same machine.
//
//   npm run bench
//
// engineReadyMs    page load to OpenCV ready in both workers
// detectMs         median detection per synthetic scene (1500x2000)
// batchMs          ten library photos, picked to all listed and rendered
// longTaskMs       main-thread time lost to tasks over 50 ms during the batch
import { chromium } from "@playwright/test";
import { startStaticServer } from "./helpers/static-server.mjs";

const PORT = 8125;
const BATCH = ["plain-wood-flat", "plain-wood-tilt", "plain-dark-tilt", "form-wood", "receipt-dark",
  "carbon-wood", "blue-desk", "lamp-falloff", "a5-landscape", "strong-yaw"];

const server = await startStaticServer(new URL("../", import.meta.url).pathname, PORT);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.longTaskMs = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longTaskMs += entry.duration;
    }).observe({ entryTypes: ["longtask"] });
  });
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

  const { detectMs, files } = await page.evaluate(async (names) => {
    const times = [], files = [];
    for (const name of names) {
      const { canvas } = SyntheticScenes.render(SyntheticScenes.SCENES.find((spec) => spec.name === name));
      const started = performance.now();
      await Detect.detectCorners(canvas);
      times.push(performance.now() - started);
      files.push(new File([await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92))], `${name}.jpg`, { type: "image/jpeg" }));
    }
    window.benchFiles = files;
    times.sort((a, b) => a - b);
    return { detectMs: Math.round(times[times.length >> 1]), files: files.length };
  }, BATCH);

  const { batchMs, longTaskMs } = await page.evaluate(async () => {
    window.longTaskMs = 0;
    const started = performance.now();
    await Scanner.addPhotos(window.benchFiles.map((file) => ({ file, viewfinderCorners: null })), 0);
    while (Scanner.pages.some((p) => !p.outputBlob)) await new Promise((resolve) => setTimeout(resolve, 20));
    return { batchMs: Math.round(performance.now() - started), longTaskMs: Math.round(window.longTaskMs) };
  });

  console.log(JSON.stringify({ engineReadyMs, detectMs, photos: files, batchMs, longTaskMs }));
} finally {
  await browser.close();
  server.close();
}
