// Library photos through the whole pipeline — detection, warp, storage — and
// out again as a PDF and as numbered images, the two exports the app offers.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openApp, sceneJpeg, addPhotos, expectPages, pdfPageSizes } from "./app-helpers.mjs";

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await addPhotos(page, [await sceneJpeg(page, "plain-wood-tilt"), await sceneJpeg(page, "receipt-dark")]);
  await expectPages(page, 2);
});

test("the scans export as one PDF, a page each, in order", async ({ page }) => {
  const download = page.waitForEvent("download");
  await page.locator("#pdfBtn").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^scan-\d{8}-\d{4}\.pdf$/);
  const sizes = pdfPageSizes(await readFile(await file.path()));
  expect(sizes).toHaveLength(2);
  // Page 1 is the A4 sheet and page 2 the receipt: order kept, and each page
  // shaped like its scan.
  const [sheet, receipt] = sizes.map(({ width, height }) => width / height);
  expect(sheet).toBeGreaterThan(0.6);
  expect(receipt).toBeLessThan(0.5);
});

test("the scans export as images numbered in page order", async ({ page }) => {
  const names = [];
  page.on("download", (download) => names.push(download.suggestedFilename()));
  await page.locator("#photosBtn").click();
  await expect.poll(() => names.length, { timeout: 10_000 }).toBe(2);
  expect(names[0]).toMatch(/^scan-\d{8}-\d{4}-01\.jpg$/);
  expect(names[1]).toMatch(/^scan-\d{8}-\d{4}-02\.jpg$/);
});
