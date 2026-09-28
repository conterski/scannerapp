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
  // Page 1 is the A4 sheet, photographed tilted: its perspective read, it
  // snaps to A4 and the PDF page is A4 to the point. Page 2 is the receipt,
  // no paper size: its own shape, long edge at A4's.
  const [sheet, receipt] = sizes;
  expect(sheet).toEqual({ width: 595.28, height: 841.89 });
  expect(receipt.height).toBeCloseTo(842, 0);
  expect(receipt.width / receipt.height).toBeCloseTo(80 / 210, 1);
});

test("the scans export as images numbered in page order", async ({ page }) => {
  const names = [];
  page.on("download", (download) => names.push(download.suggestedFilename()));
  await page.locator("#photosBtn").click();
  await expect.poll(() => names.length, { timeout: 10_000 }).toBe(2);
  expect(names[0]).toMatch(/^scan-\d{8}-\d{4}-01\.jpg$/);
  expect(names[1]).toMatch(/^scan-\d{8}-\d{4}-02\.jpg$/);
});
