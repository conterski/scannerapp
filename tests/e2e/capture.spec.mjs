// The in-page camera on a synthetic scene: the stream opens, the live
// outline finds the page, a tap becomes a photo, and Done hands the shots to
// the pipeline as cropped pages.
import { test, expect } from "@playwright/test";
import { openApp, expectPages } from "./app-helpers.mjs";

// A 16:9 stream, the shape the camera is asked for today.
const PHONE_FORMATS = [[2160, 3840], [1080, 1920]];

async function openCamera(page, { scene = "plain-wood-flat", formats = PHONE_FORMATS } = {}) {
  await page.evaluate(({ scene, formats }) => { window.cameraLog = FakeCamera.install({ scene, formats }); }, { scene, formats });
  await page.locator("#cameraBtn").click();
  await expect(page.locator("#shutterBtn")).toBeEnabled({ timeout: 60_000 });
}

test("a tap on the shutter becomes a cropped page", async ({ page }) => {
  await openApp(page);
  await openCamera(page);
  await expect(page.locator("#frameInfo")).toHaveText(/^2160×3840 · 30 fps → 2850$/);
  await expect(page.locator("#captureOutline")).not.toHaveAttribute("hidden", "", { timeout: 30_000 });

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
  expect(await page.locator("#captureVideo").evaluate((video) => video.srcObject)).toBeNull();
  await expect(page.locator(".page-card")).toHaveCount(0);
});
