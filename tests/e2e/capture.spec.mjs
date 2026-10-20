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

// An iPhone's cameras as the browser lists them: the fused camera a plain
// request is answered by, the lenses, and the front one.
const IPHONE_CAMERAS = [
  { label: "Back Triple Camera", deviceId: "triple" },
  { label: "Back Ultra Wide Camera", deviceId: "ultra" },
  { label: "Back Camera", deviceId: "main" },
  { label: "Front Camera", deviceId: "front" },
];
const ONE_LENS_CAMERAS = [{ label: "Back Camera", deviceId: "main" }, { label: "Front Camera", deviceId: "front" }];

async function openCamera(page, { scene = "plain-wood-flat", formats = FULL_4_3, cameras = null } = {}) {
  await page.evaluate(({ scene, formats, cameras }) => { window.cameraLog = FakeCamera.install({ scene, formats, cameras }); }, { scene, formats, cameras });
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

test("a phone that keeps its small 4:3 frame when asked to switch is not waited on", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { window.cameraLog = FakeCamera.install({ scene: "plain-wood-flat", formats: [[1440, 1920]] }); });
  const clicked = Date.now();
  await page.locator("#cameraBtn").click();
  await expect(page.locator("#shutterBtn")).toBeEnabled({ timeout: 60_000 });
  expect(Date.now() - clicked).toBeLessThan(1500); // the resize deadline is 2 s
  await expect(page.locator("#frameInfo")).toHaveText("1440×1920 · 30 fps");
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
  // A look at the shots and back, the page still under the camera: not taken again.
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator("#shotStrip").click();
  await page.locator("#galleryCloseBtn").click();
  await page.waitForTimeout(3000);
  await expect(page.locator("#shotCount")).toHaveText("1 photo");
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

const activeCamera = (page) => page.evaluate(() => window.cameraLog.activeDeviceId);

/** The zoom the viewfinder is showing: how far it is magnified, and how far in from its box's edges the kept part lies. */
async function zoomShown(page) {
  const { zoom, clip } = await page.evaluate(() => {
    const style = document.getElementById("captureView").style;
    return { zoom: style.getPropertyValue("--capture-zoom"), clip: style.getPropertyValue("--capture-clip") };
  });
  const [vertical, horizontal] = clip.split(" ").map(parseFloat);
  return { zoom, vertical, horizontal };
}

test("the main lens is pinned at the start, not left to the phone's fused camera", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });
  expect(await activeCamera(page)).toBe("main");
  const requests = await page.evaluate(() => window.cameraLog.requests.map((request) => request.video.deviceId || null));
  expect(requests).toEqual([null, { exact: "main" }]); // one open to learn the lenses, one pinned
  await expect(page.locator('.zoom-chip[data-step="1"]')).toHaveClass(/is-on/);
  await expect(page.locator("#macroBtn")).toHaveAttribute("aria-pressed", "false");
});

test("0.5× is the whole ultra-wide view, and the zoom row and the Macro button take turns", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });

  await page.locator('.zoom-chip[data-step="0.5"]').click();
  await expect.poll(() => activeCamera(page)).toBe("ultra");
  await expect(page.locator("#shutterBtn")).toBeEnabled();
  await expect(page.locator('.zoom-chip[data-step="0.5"]')).toHaveClass(/is-on/);
  await expect(page.locator("#macroBtn")).toHaveAttribute("aria-pressed", "false");
  expect(await zoomShown(page)).toMatchObject({ zoom: "1" }); // nothing cropped

  await page.locator('.zoom-chip[data-step="2"]').click();
  await expect.poll(() => activeCamera(page)).toBe("main");
  await expect(page.locator('.zoom-chip[data-step="2"]')).toHaveClass(/is-on/);
});

test("Macro is the ultra-wide cropped to its middle half, so the view looks like 1×", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });

  await page.locator("#macroBtn").click();
  await expect.poll(() => activeCamera(page)).toBe("ultra");
  await expect(page.locator("#shutterBtn")).toBeEnabled();
  await expect(page.locator("#macroBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".zoom-chip[data-step].is-on")).toHaveCount(0); // macro is a view of its own
  const shown = await zoomShown(page);
  expect(shown.zoom).toBe("2");
  expect(shown.vertical).toBeCloseTo(292, 1);
  expect(shown.horizontal).toBeCloseTo(97.5, 1);

  // What is kept is what is shown: the middle quarter of the ultra-wide's frame.
  await page.locator("#shutterBtn").click();
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });
  const size = await page.locator("#shotStrip img").evaluate((image) => [image.naturalWidth, image.naturalHeight]);
  expect(size).toEqual([1512, 2016]);

  // Off again: the zoom step it was on, on its own lens.
  await page.locator("#macroBtn").click();
  await expect.poll(() => activeCamera(page)).toBe("main");
  await expect(page.locator("#macroBtn")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('.zoom-chip[data-step="1"]')).toHaveClass(/is-on/);

  // Macro from the ultra-wide at 0.5× needs no new camera, only the crop.
  await page.locator('.zoom-chip[data-step="0.5"]').click();
  await expect.poll(() => activeCamera(page)).toBe("ultra");
  const opened = await page.evaluate(() => window.cameraLog.requests.length);
  await page.locator("#macroBtn").click();
  await expect(page.locator("#macroBtn")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.cameraLog.requests.length)).toBe(opened);
  expect((await zoomShown(page)).zoom).toBe("2");
});

test("the lens choice is remembered for the next time the camera opens", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });
  await page.locator("#macroBtn").click();
  await expect.poll(() => activeCamera(page)).toBe("ultra");
  await page.locator("#captureDoneBtn").click();
  await expect(page.locator("#captureView")).toBeHidden();
  await openCamera(page, { cameras: IPHONE_CAMERAS });
  expect(await activeCamera(page)).toBe("ultra");
  await expect(page.locator("#macroBtn")).toHaveAttribute("aria-pressed", "true");
});

test("2× stays on the main lens, shows the middle of the frame, and keeps exactly that", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });
  const opened = await page.evaluate(() => window.cameraLog.requests.length);

  await page.locator('.zoom-chip[data-step="2"]').click();
  expect(await page.evaluate(() => window.cameraLog.requests.length)).toBe(opened); // a crop, not a new camera
  const shown = await page.evaluate(() => {
    const style = document.getElementById("captureView").style;
    return { zoom: style.getPropertyValue("--capture-zoom"), clip: style.getPropertyValue("--capture-clip") };
  });
  expect(shown.zoom).toBe("2");
  // A 3:4 frame letterboxed on 390×844: 390 wide, 520 tall, so the half of it kept is 97.5px in from the sides.
  const [vertical, horizontal] = shown.clip.split(" ").map(parseFloat);
  expect(vertical).toBeCloseTo(292, 1);
  expect(horizontal).toBeCloseTo(97.5, 1);

  await page.locator("#shutterBtn").click();
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });
  const size = await page.locator("#shotStrip img").evaluate((image) => [image.naturalWidth, image.naturalHeight]);
  expect(size).toEqual([1512, 2016]); // the middle quarter of the 3024×4032 frame
});

test("Macro sits beside 3× in the one centred zoom group", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });
  const labels = await page.locator("#zoomBar button:visible").allTextContents();
  expect(labels).toEqual(["0.5×", "1×", "2×", "3×", "MACRO"]);
  const bar = await page.locator("#zoomBar").boundingBox();
  expect(bar.x + bar.width / 2).toBeCloseTo(195, 0); // the middle of a 390px screen
});

test("a phone without an ultra-wide offers neither Macro nor 0.5×", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: ONE_LENS_CAMERAS });
  await expect(page.locator("#macroBtn")).toBeHidden();
  await expect(page.locator('.zoom-chip[data-step="0.5"]')).toBeHidden();
  await expect(page.locator('.zoom-chip[data-step="3"]')).toBeVisible();
  expect(await activeCamera(page)).toBe("main");
});

test("a lens that will not open is put back, and the camera carries on", async ({ page }) => {
  await openApp(page);
  await openCamera(page, { cameras: IPHONE_CAMERAS });
  await page.evaluate(() => {
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.video.deviceId && constraints.video.deviceId.exact === "ultra") {
        throw Object.assign(new Error("busy"), { name: "NotReadableError" });
      }
      return open(constraints);
    };
  });
  await page.locator('.zoom-chip[data-step="0.5"]').click();
  await expect(page.locator("#captureHint")).toHaveText("That lens wouldn't open");
  await expect(page.locator("#shutterBtn")).toBeEnabled();
  await expect(page.locator('.zoom-chip[data-step="1"]')).toHaveClass(/is-on/);
  expect(await activeCamera(page)).toBe("main");
  await page.locator("#shutterBtn").click();
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });
});

test("a black frame is never saved as a shot", async ({ page }) => {
  await openApp(page);
  await openCamera(page);
  await page.evaluate(() => { window.cameraLog.blank = true; });
  await page.waitForTimeout(300);
  await page.locator("#shutterBtn").click();
  await expect(page.locator("#captureHint")).toHaveText("That shot came out blank — try again");
  await expect(page.locator("#shotCount")).toHaveText("0 photos");
  await expect(page.locator("#shotStrip")).toBeHidden();

  await page.evaluate(() => { window.cameraLog.blank = false; });
  await page.waitForTimeout(300);
  await page.locator("#shutterBtn").click();
  await expect(page.locator("#shotStrip img")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#shotCount")).toHaveText("1 photo");
});

test("zoomed in, the outline finds a page that fills the zoomed view, and lies where the view shows it", async ({ page }) => {
  await openApp(page);
  // A page covering 15% of the frame sits inside the middle quarter that 2× keeps, and fills most of it.
  await openCamera(page, { scene: { paper: "a4", background: "dark", fill: 0.15 }, cameras: IPHONE_CAMERAS });
  await outlineShown(page);
  await page.locator('.zoom-chip[data-step="2"]').click();
  await outlineShown(page);
  await page.waitForTimeout(1000);
  const { drawn, expected } = await page.evaluate(() => {
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
    };
  });
  // The outline stays in the video's own pixels, which the zoom then magnifies with the video.
  drawn.forEach(([x, y], i) => {
    expect(Math.hypot(x - expected[i][0], y - expected[i][1]), `corner ${i}`).toBeLessThan(0.03 * 390);
  });
});
