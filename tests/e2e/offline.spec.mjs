// Offline use: a deployed copy of the app — stamped the way deploy.sh stamps
// it — visited once, then opened again with the server gone. The page, its
// scripts, both workers and the OpenCV build must all come from the service
// worker's copy, and a photo must still become a scan and a PDF.
//
// The app never registers its service worker on localhost (a copy being
// worked on), so this one is served under another name, mapped to this
// machine and treated as a secure origin for the test.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticServer } from "../helpers/static-server.mjs";
import { sceneJpeg, expectPages, pdfPageSizes } from "./app-helpers.mjs";
import { readFile } from "node:fs/promises";

const HOST = "scannerapp.test";
const PORT = 8131;
const ORIGIN = `http://${HOST}:${PORT}`;
const ROOT = new URL("../../", import.meta.url).pathname;

test.use({
  // Full Chromium (headless): the lighter headless shell ignores the flag
  // that makes the mapped origin a secure one.
  channel: "chromium",
  launchOptions: {
    args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`],
  },
});

let site, server;

test.beforeAll(async () => {
  // The working tree as it would be deployed: the tracked and new files,
  // none of the ignored ones, stamped.
  site = mkdtempSync(join(tmpdir(), "scannerapp-site-"));
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  for (const file of files) cpSync(join(ROOT, file), join(site, file), { recursive: true });
  execFileSync(join(ROOT, "scripts/stamp.sh"), ["offlinetest", "offlinevendor", site]);
  server = await startStaticServer(site, PORT);
});

test.afterAll(() => {
  if (server) { server.close(); server.closeAllConnections(); }
  if (site) rmSync(site, { recursive: true, force: true });
});

test("a visited copy opens, scans and exports with the server gone", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.evaluate(() => navigator.serviceWorker.ready); // installed: everything held
  await page.addScriptTag({ url: "dev/quad-tools.js" });
  await page.addScriptTag({ url: "tests/fixtures/synthetic-scenes.js" });
  const photo = await sceneJpeg(page, "form-wood"); // made while the fixtures can still be fetched

  // The server goes: nothing can be fetched from here on.
  server.close();
  server.closeAllConnections();
  server = null;

  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.locator("#addPhotosBtn")).toBeVisible();

  await page.locator("#fileInput").setInputFiles(photo);
  await expectPages(page, 1);
  await expect(page.locator(".page-card--failed")).toHaveCount(0);

  const download = page.waitForEvent("download");
  await page.locator("#pdfBtn").click();
  const sizes = pdfPageSizes(await readFile(await (await download).path()));
  expect(sizes).toEqual([{ width: 595.28, height: 841.89 }]);
});
