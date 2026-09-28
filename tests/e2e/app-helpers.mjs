// Shared steps for the specs that drive the app page itself.
import { expect } from "@playwright/test";

/** The app with the test fixtures loaded beside it and the share sheet
 *  switched off, so every export takes the download path the test can see. */
export async function openApp(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  await page.goto("/index.html");
  await page.addScriptTag({ url: "dev/quad-tools.js" });
  await page.addScriptTag({ url: "tests/fixtures/synthetic-scenes.js" });
  await page.addScriptTag({ url: "tests/fixtures/fake-camera.js" });
}

/** A synthetic scene as the JPEG a photo library would hand over. */
export async function sceneJpeg(page, name) {
  const base64 = await page.evaluate(async (sceneName) => {
    const spec = SyntheticScenes.SCENES.find((candidate) => candidate.name === sceneName);
    const { canvas } = SyntheticScenes.render(spec);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, name);
  return { name: `${name}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
}

/** Waits until `count` pages are listed and nothing is still processing. */
export async function expectPages(page, count) {
  await expect(page.locator(".page-card")).toHaveCount(count, { timeout: 120_000 });
  await expect(page.locator("#busyOverlay")).toBeHidden({ timeout: 120_000 });
}

/** Adds library photos. With pages already listed the app asks where they
 *  go; `atEnd` answers with its default, the end of the list. */
export async function addPhotos(page, files, { atEnd = false } = {}) {
  await page.locator("#fileInput").setInputFiles(files);
  if (atEnd) await page.locator("#choicePromptList button").last().click();
}

/** The page sizes, in points, of a PDF's pages. */
export function pdfPageSizes(bytes) {
  const text = bytes.toString("latin1");
  expect(text.startsWith("%PDF")).toBe(true);
  return [...text.matchAll(/\/MediaBox \[([\d. ]+)\]/g)].map((match) => {
    const [, , width, height] = match[1].trim().split(/\s+/).map(Number);
    return { width, height };
  });
}
