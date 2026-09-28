// Playwright runs the browser-side tests: the detector on synthetic scenes,
// the capture screen on a synthetic camera, export and offline use. The app
// is served as-is by tests/helpers/static-server.mjs — there is no build.
import { defineConfig } from "@playwright/test";

const PORT = 8123;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.mjs",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1, // one OpenCV compile at a time: the machines this runs on are small
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    // An iPhone-sized page: the capture screen's layout is judged at this size.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    acceptDownloads: true,
  },
  webServer: {
    command: `node tests/helpers/static-server.mjs . ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
