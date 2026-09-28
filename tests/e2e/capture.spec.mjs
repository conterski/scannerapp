// The in-page camera on a synthetic scene: the stream opens at the frame
// that puts the most pixels on a page, the live outline finds the page where
// it is on screen, the hints and the auto shutter read it, a tap becomes a
// photo, and Done hands the shots to the pipeline as cropped pages.
import { test, expect } from "@playwright/test";
import { openApp, expectPages } from "./app-helpers.mjs";

// Phones as the camera sees them, portrait: one that offers a full-size 4:3
// frame, one that offers 16:9 only, and one whose 4:3 frames are all small.
const FULL_4_3 = [[3024, 4032], [2160, 3840], [1080, 1920]];
const ONLY_16_9 = [[2160, 3840], [1080, 1920]];
const SMALL_4_3 = [[1440, 1920], [2160, 3840]];

// A page pushed off the right of the frame, for the cut-off cases.
const RUNS_OFF = { paper: "a4", background: "dark", fill: 0.55, offset: [0.32, 0] };

async function openCamera(page, { scene = "plain-wood-flat", formats = FULL_4_3 } = {}) {
  await page.evaluate(({ scene, formats }) => { window.cameraLog = FakeCamera.install({ scene, formats }); }, { scene, formats });
  await page.locator("#cameraBtn").click();
  await expect(page.locator("#shutterBtn")).toBeEnabled({ timeout: 60_000 });
}

const outlineShown = (page) => expect(page.locator("#captureOutline")).not.toHaveAttribute("hidden", "", { timeout: 30_000 });

test("a phone with a full-size 4:3 frame is given it", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { formats: FULL_4_3 });
  await expect(page.locator("#frameInfo")).toHaveText("3024×4032 · 30 fps → 2850");
  expect(await page.evaluate(() => window.cameraLog.applied.length)).toBe(0);
});

test("a phone offering only 16:9 keeps its 16:9 frame, asked once", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { formats: ONLY_16_9 });
  await expect(page.locator("#frameInfo")).toHaveText("2160×3840 · 30 fps → 2850");
  expect(await page.evaluate(() => window.cameraLog.applied.length)).toBe(0);
});

test("a phone whose 4:3 frames are small is switched to its larger 16:9 frame, once", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { formats: SMALL_4_3 });
  await expect(page.locator("#frameInfo")).toHaveText("2160×3840 · 30 fps → 2850");
  expect(await page.evaluate(() => window.cameraLog.applied.length)).toBe(1);
});

test("the outline sits on the page as the letterboxed preview shows it", async ({ page }) => {
  await openApp(page);
  await openCamera(page);
  await outlineShown(page);
  await page.waitForTimeout(1000); // let the fused outline settle
  const { drawn, expected, width } = await page.evaluate(() => {
    const video = document.getElementById("captureVideo");
    const box = { width: video.clientWidth, height: video.clientHeight };
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const offsetX = (box.width - video.videoWidth * scale) / 2, offsetY = (box.height - video.videoHeight * scale) / 2;
    const truth = window.cameraLog.truthInFrame();
    const points = document.querySelector("#captureOutline polygon").getAttribute("points").trim().split(/\s+/)
      .map((pair) => pair.split(",").map(Number));
    return {
      drawn: points,
      expected: ["tl", "tr", "br", "bl"].map((key) => [truth[key].x * scale + offsetX, truth[key].y * scale + offsetY]),
      width: box.width,
    };
  });
  drawn.forEach(([x, y], i) => {
    expect(Math.hypot(x - expected[i][0], y - expected[i][1]), `corner ${i}`).toBeLessThan(0.03 * width);
  });
});

test("a page running off the frame is called out, and its shot flagged for a check", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { scene: RUNS_OFF });
  await expect(page.locator("#captureHint")).toHaveText("Move back — the page runs off the edge", { timeout: 30_000 });
  await page.locator("#shutterBtn").click();
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator("#captureDoneBtn").click();
  await expectPages(page, 1);
  await expect(page.locator(".page-card--check")).toHaveCount(1);
});

test("glare on the page is called out", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { scene: "glare-on-page" });
  await expect(page.locator("#captureHint")).toHaveText(/^Glare on the page/, { timeout: 30_000 });
});

test("auto capture takes a steady page once, and not again while it stays", async ({ page }) => {
  await openApp(page);
  await openCamera(page);
  await page.locator("#autoBtn").click();
  await expect(page.locator("#autoBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#shotCount")).toHaveText("1 photo", { timeout: 30_000 });
  await page.waitForTimeout(3000);
  await expect(page.locator("#shotCount")).toHaveText("1 photo");
  await page.screenshot({ path: test.info().outputPath("capture-screen.png") });
});

test("a tap on the shutter becomes a cropped page", async ({ page }) => {
  await openApp(page);
  await openCamera(page);
  await outlineShown(page);
  await expect(page.locator("#captureHint")).toBeHidden();

  await page.locator("#shutterBtn").click();
  await expect(page.locator("#shotCount")).toHaveText("1 photo");
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });

  await page.locator("#captureDoneBtn").click();
  await expect(page.locator("#captureView")).toBeHidden({ timeout: 30_000 });
  await expectPages(page, 1);
  await expect(page.locator(".page-card--check")).toHaveCount(0);
});

test("leaving the camera releases the stream", async ({ page }) => {
  await openApp(page);
  await openCamera(page);
  await page.locator("#captureDoneBtn").click();
  await expect(page.locator("#captureView")).toBeHidden();
  expect(await page.evaluate(() => document.getElementById("captureVideo").srcObject)).toBeNull();
  await expect(page.locator(".page-card")).toHaveCount(0);
});
