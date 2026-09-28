// The detector on the synthetic suite, held against its recorded baseline.
// A scene that was not cut must never become cut, and the mean IoU may not
// fall; every corner that moves is listed, so a deliberate change can be
// judged scene by scene before the baseline is re-recorded.
//
//   UPDATE_BASELINE=1 npx playwright test detector   re-record the baseline
//   STRICT_BASELINE=1 npx playwright test detector   also demand identical
//                                                    corners (a rebuilt engine
//                                                    must change nothing)
import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const BASELINE_PATH = new URL("../baseline/detector.json", import.meta.url);
const MEAN_IOU_SLACK = 0.005;
const MOVED_PX = 0.5;       // reported as moved beyond this
const IDENTICAL_PX = 0.05;  // STRICT_BASELINE's tolerance: rounding, not change

async function readBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Runs every synthetic scene through the detector and the live outline, in
 *  the page, and grades each crop against the scene's true corners. */
async function runSuite(page) {
  await page.goto("/tests/e2e/harness.html");
  return page.evaluate(async () => {
    const round = (quad) => quad && ImageUtils.mapCorners(quad, (p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) }));
    await Detect.ensureOpenCV();
    const scenes = {};
    const times = [];
    for (const spec of SyntheticScenes.SCENES) {
      const { canvas, truth } = SyntheticScenes.render(spec);
      const started = performance.now();
      const detected = await Detect.detectCorners(canvas);
      times.push(performance.now() - started);
      const preview = await Detect.previewCorners(canvas);
      const grade = QuadTools.gradeQuad(detected.corners, truth, canvas);
      scenes[spec.name] = {
        corners: round(detected.corners),
        preview: round(preview),
        confidence: detected.confidence.overall,
        cut: grade.cut, iou: grade.iou, sideError: grade.sideError, excess: grade.excess,
      };
      ImageUtils.releaseCanvas(canvas);
    }
    const values = Object.values(scenes);
    const mean = (key) => +(values.reduce((sum, scene) => sum + scene[key], 0) / values.length).toFixed(4);
    times.sort((a, b) => a - b);
    return {
      scenes,
      summary: {
        zeroCutRate: +(values.filter((scene) => !scene.cut).length / values.length).toFixed(3),
        meanIoU: mean("iou"), meanSideError: mean("sideError"), meanExcess: mean("excess"),
      },
      medianMs: Math.round(times[times.length >> 1]),
    };
  });
}

function maxCornerShift(a, b) {
  if (!a || !b) return a === b ? 0 : Infinity;
  return Math.max(...["tl", "tr", "br", "bl"].map((key) => Math.hypot(a[key].x - b[key].x, a[key].y - b[key].y)));
}

test("the detector holds its baseline on the synthetic scenes", async ({ page }) => {
  const run = await runSuite(page);
  console.log(`synthetic suite: ${JSON.stringify(run.summary)}, median ${run.medianMs} ms/scene`);
  const baseline = await readBaseline();
  if (!baseline || process.env.UPDATE_BASELINE) {
    const { medianMs, ...recorded } = run; // timing is the machine's, not the detector's
    await writeFile(BASELINE_PATH, JSON.stringify(recorded, null, 2) + "\n");
    test.info().annotations.push({ type: "baseline", description: "recorded" });
    return;
  }

  const moved = [], newlyCut = [], notIdentical = [];
  for (const [name, now] of Object.entries(run.scenes)) {
    const before = baseline.scenes[name];
    expect(before, `${name} is missing from the baseline — re-record it`).toBeTruthy();
    const shift = Math.max(maxCornerShift(now.corners, before.corners), maxCornerShift(now.preview, before.preview));
    if (shift > MOVED_PX) moved.push(`${name}: ${shift.toFixed(1)} px, IoU ${before.iou} → ${now.iou}`);
    if (shift > IDENTICAL_PX) notIdentical.push(`${name}: ${shift.toFixed(3)} px`);
    if (now.cut && !before.cut) newlyCut.push(name);
  }
  if (moved.length) console.log(`moved:\n  ${moved.join("\n  ")}`);

  expect(newlyCut, "scenes that are now cut").toEqual([]);
  expect(run.summary.meanIoU).toBeGreaterThanOrEqual(baseline.summary.meanIoU - MEAN_IOU_SLACK);
  if (process.env.STRICT_BASELINE) expect(notIdentical, "corners that changed").toEqual([]);
});

test("the warp gives every scene its true proportions", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const errors = await page.evaluate(async () => {
    const errors = {};
    for (const spec of SyntheticScenes.SCENES) {
      const { canvas, truth, aspect } = SyntheticScenes.render(spec);
      const scan = await Detect.warpPerspective(canvas, truth);
      errors[spec.name] = +Math.abs(scan.width / scan.height / aspect - 1).toFixed(4);
      ImageUtils.releaseCanvas(scan);
      ImageUtils.releaseCanvas(canvas);
    }
    return errors;
  });
  const off = Object.entries(errors).filter(([, error]) => error > 0.015);
  expect(off, "scenes whose scan is more than 1.5% off the sheet's proportions").toEqual([]);
});

test("a scan capped by maxDim is shrunk whole, proportions kept", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const { full, capped } = await page.evaluate(async () => {
    const { canvas, truth } = SyntheticScenes.render(SyntheticScenes.SCENES.find((spec) => spec.name === "form-wood"));
    const size = (scan) => { const { width, height } = scan; ImageUtils.releaseCanvas(scan); return { width, height }; };
    return {
      full: size(await Detect.warpPerspective(canvas, truth)),
      capped: size(await Detect.warpPerspective(canvas, truth, { maxDim: 600 })),
    };
  });
  expect(Math.max(capped.width, capped.height)).toBe(600);
  expect(capped.width / capped.height).toBeCloseTo(full.width / full.height, 2);
});
