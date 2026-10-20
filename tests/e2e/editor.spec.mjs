// The crop editor: a page opens on its cropped result alone, Edit shows the
// whole photo with the crop's handles, and Apply returns to the result of the
// new crop.
import { test, expect } from "@playwright/test";
import { openApp, sceneJpeg, addPhotos, expectPages } from "./app-helpers.mjs";

const resultSize = (page) => page.locator("#resultCanvas").evaluate((canvas) => [canvas.width, canvas.height]);

async function openEditor(page) {
  await openApp(page);
  await addPhotos(page, [await sceneJpeg(page, "plain-wood-tilt")]);
  await expectPages(page, 1);
  await page.locator(".page-thumb-wrap").first().click();
  await expect(page.locator("#editorView")).toBeVisible();
  await expect.poll(async () => (await resultSize(page))[0], { timeout: 30_000 }).toBeGreaterThan(0);
}

test("a page opens on its cropped result alone, with no preview strip", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator("#resultCanvas")).toBeVisible();
  await expect(page.locator("#editorCanvas")).toBeHidden();
  await expect(page.locator(".corner-handle").first()).toBeHidden();
  await expect(page.locator("#quadOverlay")).toBeHidden();
  await expect(page.locator(".preview-row")).toHaveCount(0);
  await expect(page.locator("#editCropBtn")).toBeVisible();
  await expect(page.locator("#fullCropBtn")).toBeHidden();
  // The result is a scan of a page, not of the photo: A4's shape, upright.
  const [width, height] = await resultSize(page);
  expect(width / height).toBeCloseTo(210 / 297, 1);
});

test("Edit shows the actual photo with its handles, and Apply returns to the new crop", async ({ page }) => {
  await openEditor(page);
  const before = await resultSize(page);

  await page.locator("#editCropBtn").click();
  await expect(page.locator("#editorCanvas")).toBeVisible();
  await expect(page.locator("#resultCanvas")).toBeHidden();
  await expect(page.locator(".corner-handle")).toHaveCount(4);
  await expect(page.locator(".corner-handle").first()).toBeVisible();
  await expect(page.locator("#applyCropBtn")).toBeVisible();
  await expect(page.locator("#editCropBtn")).toBeHidden();

  // Pull the top-left corner well into the page.
  const stage = await page.locator("#editorStage").boundingBox();
  const handle = await page.locator('.corner-handle[data-corner="tl"]').boundingBox();
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + stage.width * 0.2, from.y + stage.height * 0.2, { steps: 6 });
  await page.mouse.up();

  await page.locator("#applyCropBtn").click();
  await expect(page.locator("#resultCanvas")).toBeVisible();
  await expect(page.locator("#editorCanvas")).toBeHidden();
  await expect.poll(() => resultSize(page), { timeout: 30_000 }).not.toEqual(before);
});

test("rotating in the cropped view turns the result", async ({ page }) => {
  await openEditor(page);
  const [width, height] = await resultSize(page);
  await page.locator("#rotRightBtn").click();
  await expect.poll(() => resultSize(page), { timeout: 30_000 }).toEqual([height, width]);
});

test("Cancel leaves the editor and the page as it was", async ({ page }) => {
  await openEditor(page);
  await page.locator("#editCropBtn").click();
  await page.locator("#cancelEditBtn").click();
  await expect(page.locator("#editorView")).toBeHidden();
  await expect(page.locator(".page-card")).toHaveCount(1);
  // Opening it again starts on the cropped result, not where it was left.
  await page.locator(".page-thumb-wrap").first().click();
  await expect(page.locator("#resultCanvas")).toBeVisible();
  await expect(page.locator("#editorCanvas")).toBeHidden();
});
